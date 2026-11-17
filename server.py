"""
Serviço local do PODCAST PRO para Premiere.

Roda só na sua máquina (127.0.0.1) e faz o trabalho pesado que o painel UXP
não consegue fazer sozinho:
  POST /silences   -> detecta silêncios com FFmpeg e devolve os trechos a MANTER
  POST /transcribe -> transcreve com faster-whisper e grava um arquivo .srt

Uso:  python server.py
"""

import json
import os
import math
import re
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import sys

_AQUI = os.path.dirname(os.path.abspath(__file__))
_RAIZ = os.path.abspath(os.path.join(_AQUI, ".."))

# FFmpeg que o instalador baixa fica em ..\ffmpeg (não depende do PATH do Windows)
_FF = os.path.join(_RAIZ, "ffmpeg")
if os.path.isdir(_FF):
    os.environ["PATH"] = _FF + os.pathsep + os.environ.get("PATH", "")

# Rodando em segundo plano (pythonw): sem janela preta e com um arquivo de registro
if sys.stdout is None or sys.stderr is None or os.path.basename(sys.executable).lower() == "pythonw.exe":
    _log = open(os.path.join(_RAIZ, "servidor.log"), "a", encoding="utf-8", buffering=1)
    sys.stdout = _log
    sys.stderr = _log
if os.name == "nt":  # não abrir janelinhas ao chamar o FFmpeg
    _popen_init = subprocess.Popen.__init__

    def _popen_sem_janela(self, *a, **k):
        k["creationflags"] = k.get("creationflags", 0) | 0x08000000
        _popen_init(self, *a, **k)
    subprocess.Popen.__init__ = _popen_sem_janela

HOST = "127.0.0.1"
PORT = 8765
VERSAO = "1.0.7"
URL_ATUALIZACAO = "https://raw.githubusercontent.com/podcastpro-edition/podcast-pro/main/"

RE_START = re.compile(r"silence_start:\s*(-?[\d.]+)")
RE_END = re.compile(r"silence_end:\s*(-?[\d.]+)")

_modelos = {}  # cache de modelos já carregados


# ---------------------------------------------------------------- silêncios

def duracao_total(caminho):
    saida = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", caminho],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    return float(saida.stdout.strip())


def detectar_silencios(caminho, limite_db, duracao_minima):
    """Roda o silencedetect do FFmpeg e devolve [(inicio, fim), ...] em segundos."""
    total = duracao_total(caminho)
    filtro = f"silencedetect=noise={limite_db}dB:d={duracao_minima}"
    saida = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", caminho,
         "-vn", "-af", filtro, "-f", "null", "-"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    ).stderr

    inicios = [float(x) for x in RE_START.findall(saida)]
    fins = [float(x) for x in RE_END.findall(saida)]
    if len(inicios) > len(fins):  # silêncio que vai até o fim do arquivo
        fins.append(total)

    silencios = [(max(0.0, i), min(total, f)) for i, f in zip(inicios, fins)]
    return silencios, total


def trechos_a_manter(silencios, total, respiro):
    """Inverte os silêncios. 'respiro' deixa uma folga nas bordas de cada fala.
    O fim da fala ganha 50% a mais de folga que o começo, porque o final das
    palavras é mais fraco e costuma ser cortado cedo demais."""
    folga_depois = respiro * 1.5  # sobra depois da fala
    folga_antes = respiro         # sobra antes da fala seguinte
    reduzidos = []
    for ini, fim in silencios:
        ini2, fim2 = ini + folga_depois, fim - folga_antes
        if fim2 > ini2:
            reduzidos.append((ini2, fim2))

    manter, cursor = [], 0.0
    for ini, fim in reduzidos:
        if ini - cursor > 0.05:
            manter.append((cursor, ini))
        cursor = fim
    if total - cursor > 0.05:
        manter.append((cursor, total))
    return manter


# ----------------------------------------------------------------- legendas

def formatar_tempo_srt(segundos):
    ms = int(round(segundos * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def carregar_modelo(nome, dispositivo):
    from faster_whisper import WhisperModel  # import tardio: só quando precisar

    chave = (nome, dispositivo)
    if chave not in _modelos:
        tipo = "int8_float16" if dispositivo == "cuda" else "int8"
        _modelos[chave] = WhisperModel(nome, device=dispositivo, compute_type=tipo)
    return _modelos[chave]


def ler_audio(caminho):
    """Extrai o áudio com o FFmpeg (mono, 16 kHz) e devolve como lista de números.
    Evita a biblioteca 'av', que estava incompatível nesta instalação."""
    import numpy as np

    resultado = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", caminho,
         "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
        capture_output=True,
    )
    if resultado.returncode != 0 or not resultado.stdout:
        erro = resultado.stderr.decode("utf-8", errors="replace")
        raise RuntimeError("FFmpeg não conseguiu ler o áudio: " + erro[-300:])
    return np.frombuffer(resultado.stdout, dtype=np.float32)


def transcrever(caminho, modelo, dispositivo, idioma):
    whisper = carregar_modelo(modelo, dispositivo)
    audio = ler_audio(caminho)
    segmentos, _ = whisper.transcribe(
        audio, language=idioma, vad_filter=True, beam_size=5
    )
    destino = os.path.splitext(caminho)[0] + ".srt"
    with open(destino, "w", encoding="utf-8") as f:
        n = 0
        for seg in segmentos:
            texto = seg.text.strip()
            if not texto:
                continue
            n += 1
            f.write(f"{n}\n{formatar_tempo_srt(seg.start)} --> "
                    f"{formatar_tempo_srt(seg.end)}\n{texto}\n\n")
    return destino, n


# ------------------------------------------------- legendas do vídeo cortado

MANTIDO_MINIMO = 1.0  # segundos de fala que, se sobrarem, garantem a legenda

RE_TEMPO = re.compile(r"(\d+):(\d+):(\d+)[,.](\d+)")


def ler_tempo_srt(texto):
    h, m, s, ms = RE_TEMPO.search(texto).groups()
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms.ljust(3, "0")[:3]) / 1000


def ler_srt(caminho):
    with open(caminho, encoding="utf-8-sig") as f:
        texto = f.read().replace("\r\n", "\n")
    falas = []
    for bloco in texto.strip().split("\n\n"):
        linhas = bloco.split("\n")
        pos = next((i for i, l in enumerate(linhas) if "-->" in l), None)
        if pos is None:
            continue
        ini, fim = linhas[pos].split("-->")
        falas.append((ler_tempo_srt(ini), ler_tempo_srt(fim),
                      "\n".join(linhas[pos + 1:]).strip()))
    return falas


def reposicionar_falas(falas, trechos, descartadas=None):
    """trechos: lista de {a, b, t} = início/fim no vídeo original e onde ele
    começa na sequência cortada. Devolve as falas com os tempos novos.
    Se 'descartadas' for uma lista, nela entram as falas removidas e o motivo."""
    def descartar(ini, fim, texto, motivo):
        if descartadas is not None:
            descartadas.append((ini, fim, texto, motivo))

    novas = []
    for ini, fim, texto in falas:
        dentro = [x for x in trechos if x["a"] < fim and x["b"] > ini]
        if not texto:
            continue
        if not dentro:
            descartar(ini, fim, texto, "toda a fala caiu em silêncio removido")
            continue
        # A legenda só é descartada se sobrou pouquíssimo da fala no vídeo:
        # menos de 1 segundo E menos da metade. Assim, trechos de áudio que
        # ficaram (mesmo que seja só uma parte de uma fala longa) mantêm legenda,
        # e pedaços minúsculos de perguntas cortadas não ganham legenda.
        mantido = sum(max(0.0, min(fim, x["b"]) - max(ini, x["a"])) for x in dentro)
        if mantido < MANTIDO_MINIMO and mantido < 0.5 * (fim - ini):
            descartar(ini, fim, texto,
                      f"só {mantido:.1f}s de {fim - ini:.1f}s da fala ficaram no vídeo")
            continue
        primeiro, ultimo = dentro[0], dentro[-1]
        novo_ini = primeiro["t"] + (max(ini, primeiro["a"]) - primeiro["a"])
        novo_fim = ultimo["t"] + (min(fim, ultimo["b"]) - ultimo["a"])
        if novo_fim - novo_ini >= 0.05:
            novas.append((novo_ini, novo_fim, texto))
        else:
            descartar(ini, fim, texto, "ficou curta demais depois do ajuste")
    return novas


def gravar_srt(caminho, falas):
    with open(caminho, "w", encoding="utf-8") as f:
        for n, (ini, fim, texto) in enumerate(falas, 1):
            f.write(f"{n}\n{formatar_tempo_srt(ini)} --> "
                    f"{formatar_tempo_srt(fim)}\n{texto}\n\n")



# ------------------------------------------------------------------ podcast

def ler_canal(caminho, canal=None, taxa=8000, inicio=0.0, duracao=None):
    """Lê um canal do arquivo (0 = primeiro) em mono; canal=None mistura tudo."""
    import numpy as np

    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
    if inicio:
        cmd += ["-ss", str(inicio)]
    if duracao:
        cmd += ["-t", str(duracao)]
    cmd += ["-i", caminho, "-vn"]
    if canal is None:
        cmd += ["-ac", "1"]
    else:
        cmd += ["-af", f"pan=mono|c0=c{int(canal)}"]
    cmd += ["-ar", str(taxa), "-f", "f32le", "-"]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0 or not r.stdout:
        raise RuntimeError("FFmpeg não leu o áudio: " + r.stderr.decode("utf-8", "replace")[-300:])
    return np.frombuffer(r.stdout, dtype=np.float32)


def envelope_db(x, taxa, janela):
    """Volume (dB) a cada 'janela' segundos."""
    import numpy as np

    n = int(taxa * janela)
    total = len(x) // n
    blocos = x[: total * n].reshape(total, n)
    rms = np.sqrt((blocos ** 2).mean(axis=1) + 1e-12)
    return 20 * np.log10(rms + 1e-9)


def quem_fala(pessoas, caminho, janela=0.1, margem_db=6.0, acima_ruido_db=12.0,
              duracao_minima=2.0):
    """pessoas: [{nome, canal, camera}]. Devolve (trechos, tempo_por_pessoa).
    Cada trecho: {ini, fim, quem, camera}. 'quem' = nome ou 'geral'."""
    import numpy as np

    envs = []
    for p in pessoas:
        x = ler_canal(caminho, p["canal"], 8000)
        envs.append(envelope_db(x, 8000, janela))
    n = min(len(e) for e in envs)
    envs = np.vstack([e[:n] for e in envs])  # pessoas x janelas

    chao = np.percentile(envs, 10, axis=1)[:, None]
    ativo = envs > (chao + acima_ruido_db)

    rotulos = np.full(n, -2, dtype=int)  # -2 = ninguém ainda, -1 = geral
    for i in range(n):
        cand = np.where(ativo[:, i])[0]
        if len(cand) == 0:
            continue
        if len(cand) == 1:
            rotulos[i] = cand[0]
            continue
        ordem = cand[np.argsort(-envs[cand, i])]
        if envs[ordem[0], i] - envs[ordem[1], i] >= margem_db:
            rotulos[i] = ordem[0]
        else:
            rotulos[i] = -1

    # silêncio mantém quem falava antes
    ultimo = None
    for i in range(n):
        if rotulos[i] == -2:
            if ultimo is not None:
                rotulos[i] = ultimo
        else:
            ultimo = rotulos[i]
    primeiro = next((r for r in rotulos if r != -2), -1)
    rotulos[rotulos == -2] = primeiro

    # transforma em trechos e absorve os muito curtos
    def para_trechos(r):
        t, ini = [], 0
        for i in range(1, len(r) + 1):
            if i == len(r) or r[i] != r[ini]:
                t.append([ini, i, int(r[ini])])
                ini = i
        return t

    minimo = int(round(duracao_minima / janela))
    trechos = para_trechos(rotulos)
    while len(trechos) > 1:
        menor = min(range(len(trechos)), key=lambda k: trechos[k][1] - trechos[k][0])
        if trechos[menor][1] - trechos[menor][0] >= minimo:
            break
        if menor == 0:
            vizinho = 1
        elif menor == len(trechos) - 1:
            vizinho = menor - 1
        else:
            a, b = trechos[menor - 1], trechos[menor + 1]
            vizinho = menor - 1 if (a[1] - a[0]) >= (b[1] - b[0]) else menor + 1
        trechos[menor][2] = trechos[vizinho][2]
        # junta vizinhos de mesmo rótulo
        fundidos = [trechos[0]]
        for t in trechos[1:]:
            if t[2] == fundidos[-1][2]:
                fundidos[-1][1] = t[1]
            else:
                fundidos.append(t)
        trechos = fundidos

    tempo = {}
    saida = []
    for ini, fim, r in trechos:
        nome = "geral" if r < 0 else pessoas[r]["nome"]
        tempo[nome] = tempo.get(nome, 0.0) + (fim - ini) * janela
        saida.append({"ini": round(ini * janela, 2), "fim": round(fim * janela, 2),
                      "quem": nome, "camera": None if r < 0 else pessoas[r]["camera"]})
    return saida, tempo, ativo.any(axis=0), janela


def deslocamentos(ref, outros, duracao=600, maximo=30.0):
    """Quanto cada arquivo em 'outros' está atrasado (+) ou adiantado (-) em
    relação a 'ref', comparando o áudio (envelope). Devolve [(deslocamento, confiança)]."""
    import numpy as np

    def preparar(caminho):
        x = np.abs(ler_canal(caminho, None, 8000, 0, duracao))
        m = len(x) // 20 * 20
        x = x[:m].reshape(-1, 20).mean(axis=1)  # 400 amostras por segundo
        x = x - x.mean()
        return x / (x.std() + 1e-9)

    a = preparar(ref)
    resultado = []
    for caminho in outros:
        b = preparar(caminho)
        tam = 1
        while tam < len(a) + len(b):
            tam *= 2
        corr = np.fft.irfft(np.fft.rfft(b, tam) * np.conj(np.fft.rfft(a, tam)), tam)
        lim = int(maximo * 400)
        # lag k: b[n+k] ~ a[n]
        valores = np.concatenate([corr[-lim:], corr[: lim + 1]])
        lags = np.arange(-lim, lim + 1)
        i = int(np.argmax(valores))
        conf = float((valores[i] - valores.mean()) / (valores.std() + 1e-9))
        resultado.append((float(lags[i] / 400.0), conf))
    return resultado



def sincronia_fina(ref, outro, grosso, pad=2.0, duracao=90.0, pontos=(0.2, 0.5, 0.8)):
    """Refina o atraso 'grosso' (em segundos) olhando 3 pedaços do arquivo, com
    precisão de 1 ms. Devolve (mediana, lista de medidas)."""
    import numpy as np

    total = duracao_total(ref)

    def env(caminho, inicio, dur):
        x = np.abs(ler_canal(caminho, None, 8000, max(0.0, inicio), dur))
        m = len(x) // 8 * 8
        x = x[:m].reshape(-1, 8).mean(axis=1)  # 1000 amostras por segundo
        x = x - x.mean()
        return x / (x.std() + 1e-9)

    medidas = []
    for p in pontos:
        s = max(0.0, min(total - duracao - 1, p * total))
        a = env(ref, s, duracao)
        b = env(outro, s + grosso - pad, duracao + 2 * pad)
        tam = 1
        while tam < len(a) + len(b):
            tam *= 2
        corr = np.fft.irfft(np.fft.rfft(b, tam) * np.conj(np.fft.rfft(a, tam)), tam)
        faixa = corr[: int(2 * pad * 1000) + 1]
        lag = int(np.argmax(faixa))
        medidas.append(grosso - pad + lag / 1000.0)
    medidas.sort()
    return medidas[len(medidas) // 2], medidas


def priorizar_apresentador(trechos, pessoas, apresentadores, nivel):
    """Dá mais imagem a quem apresenta. nivel 1 = moderado, 2 = bastante.
    'apresentadores' = nome ou lista de nomes. Nos momentos em que o apresentador não está
    falando, falas curtas dos outros (reações) e momentos sem fala dominante (câmera geral)
    ficam na câmera do apresentador que falou por último (ou do primeiro, no começo)."""
    if isinstance(apresentadores, str):
        apresentadores = [apresentadores]
    apresentadores = [a for a in (apresentadores or []) if a]
    if not apresentadores or nivel <= 0:
        return trechos
    cam_de = {p["nome"]: p["camera"] for p in pessoas}
    validos = [a for a in apresentadores if a in cam_de]
    if not validos:
        return trechos
    limite = {1: 4.0, 2: 8.0}.get(nivel, 8.0)
    ultima = cam_de[validos[0]]
    for tr in trechos:
        if tr["quem"] in validos:
            ultima = cam_de[tr["quem"]]
            continue
        if tr["quem"] == "geral" or (tr["fim"] - tr["ini"]) < limite:
            tr["camera"] = ultima
    return trechos


def plano_podcast(wav, cameras, pessoas, geral, minimo, respiro, duracao_minima,
                  cortar_silencios=False, faixas=None, apresentador=None, prioridade=0):
    """Junta tudo: sincronia das câmeras, quem fala, silêncios a cortar.
    cameras: {"V1": caminho, ...}. Devolve o plano de montagem."""
    total = duracao_total(wav)
    grossos = deslocamentos(wav, [cameras[k] for k in cameras])
    atraso = {}
    for (nome, caminho), (g, conf) in zip(cameras.items(), grossos):
        fino, medidas = sincronia_fina(wav, caminho, g)
        atraso[nome] = {"valor": fino, "medidas": medidas, "confianca": conf}

    trechos, tempo, alguem, janela = quem_fala(pessoas, wav, duracao_minima=duracao_minima)
    trechos = priorizar_apresentador(trechos, pessoas, apresentador, int(prioridade or 0))

    # silêncios = janelas em que ninguém fala, com pelo menos 'minimo' segundos
    silencios, ini = [], None
    for i, a in enumerate(list(alguem) + [True]):
        if not a and ini is None:
            ini = i
        elif a and ini is not None:
            if (i - ini) * janela >= minimo:
                silencios.append((ini * janela, i * janela))
            ini = None
    # Faixa do áudio em que TODAS as câmeras têm imagem (as câmeras estão deslocadas
    # em relação ao gravador, então pode sobrar um pedaço sem vídeo no começo/fim).
    inicio_ok, fim_ok = 0.0, total
    for nome, caminho in cameras.items():
        d = atraso[nome]["valor"]
        inicio_ok = max(inicio_ok, -d)
        fim_ok = min(fim_ok, duracao_total(caminho) - d)
    if faixas:  # só estes trechos (vindos de uma busca)
        base = [(float(x), float(y)) for x, y in faixas if y - x >= 0.3]
    elif cortar_silencios:
        base = [(a, b) for a, b in trechos_a_manter(silencios, total, respiro) if b - a >= 0.3]
    else:
        base = [(0.0, total)]
    manter = []
    for a, b in base:
        a2, b2 = max(a, inicio_ok), min(b, fim_ok)
        if b2 - a2 >= 0.3:
            manter.append((a2, b2))

    def camera_em(t):
        for tr in trechos:
            if tr["ini"] <= t < tr["fim"]:
                return tr["camera"] or geral
        return geral

    pecas, relogio, keeps = [], 0.0, []
    for a, b in manter:
        keeps.append({"a": a, "b": b, "t": relogio})
        cortes = sorted({a, b} | {x for tr in trechos for x in (tr["ini"], tr["fim"]) if a < x < b})
        locais = []
        for x, y in zip(cortes, cortes[1:]):
            cam = camera_em((x + y) / 2)
            if locais and locais[-1]["camera"] == cam:
                locais[-1]["b"] = y
            else:
                locais.append({"a": x, "b": y, "camera": cam})
        # pedaços curtos demais (< 0.5 s) viram parte do vizinho: nada de "piscadas"
        while len(locais) > 1:
            k = min(range(len(locais)), key=lambda i: locais[i]["b"] - locais[i]["a"])
            if locais[k]["b"] - locais[k]["a"] >= 0.5:
                break
            v = k - 1 if k > 0 else 1
            locais[v]["a"] = min(locais[v]["a"], locais[k]["a"])
            locais[v]["b"] = max(locais[v]["b"], locais[k]["b"])
            del locais[k]
            fund = [locais[0]]
            for p in locais[1:]:
                if p["camera"] == fund[-1]["camera"]:
                    fund[-1]["b"] = p["b"]
                else:
                    fund.append(p)
            locais = fund
        for p in locais:
            p["t"] = relogio + (p["a"] - a)
            pecas.append(p)
        relogio += b - a
    return {"duracao": total, "duracaoFinal": relogio, "atraso": atraso,
            "faixaComImagem": [inicio_ok, fim_ok],
            "tempo": tempo, "keeps": keeps, "pecas": pecas}



# --------------------------------------------- legendas do podcast (por palavra)

def misturar_microfones(caminho, canais, taxa=16000):
    """Soma os canais dos microfones das pessoas (sem o ambiente das câmeras)."""
    import numpy as np

    mix = None
    for c in canais:
        x = ler_canal(caminho, c, taxa)
        if mix is None:
            mix = x.copy()
        else:
            n = min(len(mix), len(x))
            mix = mix[:n] + x[:n]
    pico = float(np.abs(mix).max()) if len(mix) else 0.0
    if pico > 0.99:
        mix = mix / pico
    return mix


def transcrever_palavras(audio, modelo, dispositivo, idioma):
    whisper = carregar_modelo(modelo, dispositivo)
    if isinstance(audio, str):  # decodifica com o FFmpeg (não depende do pacote 'av')
        audio = ler_audio(audio)
    segmentos, _ = whisper.transcribe(
        audio, language=idioma, vad_filter=True, beam_size=5,
        word_timestamps=True, condition_on_previous_text=False)
    palavras = []
    for seg in segmentos:
        for w in (seg.words or []):
            texto = w.word.strip()
            if texto:
                palavras.append({"w": texto, "s": round(w.start, 3), "e": round(w.end, 3)})
    return palavras


def legendas_em_blocos(palavras, max_chars=42, max_pausa=0.8, max_dur=4.5):
    """Agrupa palavras em legendas de uma linha. Quebra por tamanho, pausa,
    duração, fim de frase ou troca de quem fala."""
    blocos, atual = [], []

    def fechar():
        if atual:
            blocos.append((atual[0]["s"], atual[-1]["e"], " ".join(x["w"] for x in atual)))
            atual.clear()

    for p in palavras:
        if atual:
            texto = " ".join(x["w"] for x in atual) + " " + p["w"]
            pausa = p["s"] - atual[-1]["e"]
            fim_frase = atual[-1]["w"][-1] in ".?!" and (atual[-1]["e"] - atual[0]["s"]) >= 1.2
            troca = p.get("quem") != atual[0].get("quem")
            if (len(texto) > max_chars or pausa > max_pausa or fim_frase or troca
                    or p["e"] - atual[0]["s"] > max_dur):
                fechar()
        atual.append(p)
    fechar()
    return blocos


def legendas_palavra_a_palavra(palavras, max_palavras=2, max_chars=16):
    """Poucas palavras por vez, no estilo de vídeos curtos. Cada legenda dura até
    a próxima começar (no máximo 0,6 s depois da fala)."""
    grupos, atual = [], []
    for p in palavras:
        if atual:
            texto = " ".join(x["w"] for x in atual) + " " + p["w"]
            if (len(atual) >= max_palavras or len(texto) > max_chars
                    or p["s"] - atual[-1]["e"] > 0.8 or p.get("quem") != atual[0].get("quem")):
                grupos.append(atual)
                atual = []
        atual.append(p)
    if atual:
        grupos.append(atual)
    saida = []
    for i, g in enumerate(grupos):
        ini, fim = g[0]["s"], g[-1]["e"]
        limite = grupos[i + 1][0]["s"] if i + 1 < len(grupos) else fim + 0.6
        fim = max(fim, min(fim + 0.6, limite))
        saida.append((ini, fim, " ".join(x["w"] for x in g)))
    return saida


def legendas_podcast(wav, pessoas, modelo, dispositivo, idioma, reutilizar):
    base = os.path.splitext(wav)[0]
    cache = base + "_palavras.json"
    palavras = None
    if reutilizar and os.path.isfile(cache):
        with open(cache, encoding="utf-8") as f:
            palavras = json.load(f)
    reaproveitou = palavras is not None
    if palavras is None:
        audio = misturar_microfones(wav, [p["canal"] for p in pessoas])
        palavras = transcrever_palavras(audio, modelo, dispositivo, idioma)
        trechos, _, _, _ = quem_fala(pessoas, wav)
        for p in palavras:
            meio = (p["s"] + p["e"]) / 2
            p["quem"] = next((t["quem"] for t in trechos if t["ini"] <= meio < t["fim"]), "geral")
        with open(cache, "w", encoding="utf-8") as f:
            json.dump(palavras, f, ensure_ascii=False)
    padrao = base + "_legendas.srt"
    curtas = base + "_palavras.srt"
    gravar_srt(padrao, legendas_em_blocos(palavras))
    gravar_srt(curtas, legendas_palavra_a_palavra(palavras))
    return {"padrao": padrao, "curtas": curtas, "palavras": len(palavras),
            "legendasPadrao": len(legendas_em_blocos(palavras)),
            "legendasCurtas": len(legendas_palavra_a_palavra(palavras)),
            "reaproveitou": reaproveitou}



# ------------------------------------- legendas estilizadas (templates .mogrt)

ESTILOS = {  # nome -> template de legenda que o Premiere já traz instalado
    "Bold": "Bold Web Caption.mogrt",
    "Classic": "Classic Web Caption.mogrt",
    "Film": "Film Web Caption.mogrt",
    "Modern": "Modern Web Caption.mogrt",
    "Simple": "Simple Web Caption.mogrt",
}


def pasta_templates():
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    return os.path.join(base, "Adobe", "Common", "Motion Graphics Templates", "Captions and Subtitles")


def listar_mogrts():
    """Todos os .mogrt da pasta de templates do Premiere (nome amigável, caminho)."""
    raiz = os.path.dirname(pasta_templates())
    achados = []
    for pasta, _, arquivos in os.walk(raiz):
        for a in arquivos:
            if a.lower().endswith(".mogrt") and not a.lower().startswith("autocut"):
                achados.append({"nome": os.path.splitext(a)[0], "caminho": os.path.join(pasta, a)})
    achados.sort(key=lambda x: x["nome"].lower())
    return achados


def _nome_ctrl(c):
    try:
        return c["uiName"]["strDB"][0]["str"]
    except Exception:
        return ""


def _definir(controles, nome, valor):
    """Muda o valor de um controle numérico/menu pelo nome (se existir)."""
    for c in controles:
        if _nome_ctrl(c) == nome:
            c["value"] = valor
            return True
    return False


def gerar_mogrt(base, texto, destino, nome="AutoCut Legenda", enxuto=False, duracao=None,
                tempos=None, limpar_extras=False):
    """Copia um template trocando o texto. 'enxuto' tira miniaturas e idiomas extras."""
    import uuid
    import zipfile

    with zipfile.ZipFile(base) as zin:
        definicao = json.loads(zin.read("definition.json").decode("utf-8"))
        definicao["capsuleID"] = str(uuid.uuid4())  # cada template precisa de um ID próprio
        definicao["capsuleName"] = nome
        if duracao:  # grava a duração desejada no próprio template (em todos os idiomas)
            for info_loc in definicao.get("sourceInfoLocalized", {}).values():
                d = info_loc.get("duration")
                if d and d.get("scale"):
                    d["value"] = max(1, int(round(duracao * d["scale"])))
        if not any(c.get("type") == 6 for c in definicao.get("clientControls", [])):
            raise RuntimeError("Esse template não tem um campo de texto editável, então não dá para usar como legenda.")
        controles = definicao["clientControls"]
        inteligente = any(_nome_ctrl(c) == "Manual Timing Data" for c in controles)
        primeiro = True
        for c in controles:
            if c.get("type") == 6 and primeiro:  # só o 1º campo de texto
                for item in c["value"]["strDB"]:
                    item["str"] = texto
                primeiro = False
            elif (c.get("type") == 6 and limpar_extras and not inteligente
                  and _nome_ctrl(c) != "Manual Timing Data"):
                for item in c["value"]["strDB"]:  # templates com vários textos: limpa os outros
                    item["str"] = ""
        if inteligente:
            # "Smart Captions Engine": destaca a palavra que está sendo falada.
            _definir(controles, "Timing Mode", 3 if tempos else 1)  # Manual ou Igual
            _definir(controles, "Caption Mode", 1)  # por palavras
            _definir(controles, "Words Per Caption", 10)  # a frase inteira de uma vez
            _definir(controles, "Caption Line Mode", 1)
            _definir(controles, "Text Size", 330)  # o template é 4K: o padrão sai minúsculo
            _definir(controles, "Text Position", {"x": 0, "y": 650})  # parte de baixo do quadro
            _definir(controles, "Caption Max Width", 3000)
            if duracao:
                _definir(controles, "Duration, sec", int(math.ceil(duracao)))
            for c in controles:
                if tempos and _nome_ctrl(c) == "Manual Timing Data":
                    for item in c["value"]["strDB"]:
                        item["str"] = ",".join(f"{t:.2f}" for t in tempos)
        with zipfile.ZipFile(destino, "w", zipfile.ZIP_DEFLATED) as zout:
            for info in zin.infolist():
                if enxuto and not (info.filename == "definition.json" or info.filename.startswith("project.")):
                    continue
                dados = zin.read(info.filename)
                if info.filename == "definition.json":
                    dados = json.dumps(definicao, ensure_ascii=False).encode("utf-8")
                zout.writestr(info.filename, dados)


def palavras_do_trecho(caminho, inicio, fim, modelo, dispositivo, idioma):
    """Transcreve (por palavra) só o trecho [inicio, fim] de um arquivo de áudio ou vídeo.
    Guarda o resultado em ..\\cache para não repetir. Tempos devolvidos = tempos do arquivo."""
    import hashlib
    import tempfile
    st = os.stat(caminho)
    chave = hashlib.md5(f"{os.path.abspath(caminho)}|{st.st_size}|{st.st_mtime}|{inicio:.2f}|{fim:.2f}|{modelo}".encode()).hexdigest()[:16]
    pasta = os.path.join(_RAIZ, "cache")
    os.makedirs(pasta, exist_ok=True)
    cache = os.path.join(pasta, chave + "_palavras.json")
    if os.path.isfile(cache):
        with open(cache, encoding="utf-8") as f:
            return cache, len(json.load(f)), True
    dur = max(0.5, fim - inicio)
    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, "trecho.wav")
        r = subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{max(0.0, inicio):.3f}",
                            "-t", f"{dur:.3f}", "-i", caminho, "-vn", "-ac", "1", "-ar", "16000", wav],
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        if not os.path.isfile(wav):
            raise RuntimeError("Não consegui ler o áudio desse trecho: " + (r.stderr or "")[-200:])
        palavras = transcrever_palavras(wav, modelo, dispositivo, idioma)
    for p in palavras:
        p["s"] = round(p["s"] + inicio, 3)
        p["e"] = round(p["e"] + inicio, 3)
    with open(cache, "w", encoding="utf-8") as f:
        json.dump(palavras, f, ensure_ascii=False)
    return cache, len(palavras), False


def legendas_estilizadas(wav, inicio, fim, modo, estilo, pasta_saida, enxuto, semente,
                         cache=None, prefixo=""):
    import random

    cache = cache or (os.path.splitext(wav)[0] + "_palavras.json")
    if not os.path.isfile(cache):
        raise RuntimeError("Falta a transcrição por palavra deste trecho.")
    with open(cache, encoding="utf-8") as f:
        palavras = [p for p in json.load(f) if inicio <= p["s"] < fim]
    if not palavras:
        raise RuntimeError("Não há falas nesse intervalo.")
    blocos = (legendas_palavra_a_palavra(palavras) if modo == "curtas"
              else legendas_em_blocos(palavras))
    sorteio = random.Random(semente)
    nomes = list(ESTILOS)
    os.makedirs(pasta_saida, exist_ok=True)
    saida = []
    for i, (ini, fi, texto) in enumerate(blocos):
        texto = re.sub(r"(\w) -(\w)", r"\1-\2", texto)  # "Bem -vindos" -> "Bem-vindos"
        est = sorteio.choice(nomes) if estilo == "aleatorio" else estilo
        personalizado = est.lower().endswith(".mogrt")
        if personalizado:  # template escolhido pelo usuário
            base = est
            if not os.path.isfile(base):
                raise RuntimeError(f"Não achei o template: {base}")
            est = os.path.splitext(os.path.basename(base))[0]
        else:
            base = os.path.join(pasta_templates(), ESTILOS[est])
        destino = os.path.join(pasta_saida, f"legenda_{prefixo}{i:05d}.mogrt")
        pal_bloco = [p for p in palavras if ini - 0.01 <= p["s"] < fi]
        # palavras iniciadas por "-" (ex.: "Bem" + "-vindos") viram uma só no texto final
        tempos = [max(0.0, p["s"] - ini) for p in pal_bloco if not p["w"].startswith("-")]
        tempos.append(max(0.1, fi - ini))
        if len(tempos) - 1 != len(texto.split()):
            tempos = None  # sem tempos confiáveis: o template distribui por igual
        gerar_mogrt(base, texto, destino, nome=f"AutoCut {est}", enxuto=enxuto,
                    duracao=max(0.3, fi - ini), tempos=tempos, limpar_extras=personalizado)
        saida.append({"ini": ini, "fim": fi, "texto": texto, "estilo": est, "arquivo": destino})
    return saida



# ------------------------------------------------------------- recorte vertical

def tamanho_video(caminho):
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height", "-of", "csv=p=0:s=x", caminho],
        capture_output=True, text=True)
    w, h = r.stdout.strip().split("x")[:2]
    return int(w), int(h)


def rostos_no_trecho(caminho, ini, fim, passo=0.5, largura_analise=640):
    """Procura rostos num trecho do vídeo. Devolve (largura, altura, [(t, [(cx,cy,w,h)...])]),
    com tudo normalizado (0 a 1) em relação ao quadro."""
    import numpy as np
    try:
        import cv2
    except ImportError:
        raise RuntimeError("Falta instalar o rastreio de rosto: rode o INSTALAR.bat de novo "
                           "(pasta C:\\PODCAST_PRO) e depois reinicie o servidor.")
    W, H = tamanho_video(caminho)
    aw = largura_analise
    ah = int(round(H * aw / W / 2.0)) * 2
    dur = max(0.1, fim - ini)
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{max(0.0, ini):.3f}", "-t", f"{dur:.3f}",
           "-i", caminho, "-vf", f"fps={1.0 / passo:.4f},scale={aw}:{ah},format=gray",
           "-f", "rawvideo", "-"]
    bruto = subprocess.run(cmd, capture_output=True).stdout
    tam = aw * ah
    n = len(bruto) // tam
    detector = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    saida = []
    for i in range(n):
        quadro = np.frombuffer(bruto[i * tam:(i + 1) * tam], dtype=np.uint8).reshape(ah, aw)
        achados = detector.detectMultiScale(quadro, scaleFactor=1.1, minNeighbors=5,
                                            minSize=(max(18, aw // 40), max(18, aw // 40)))
        faces = [((x + w / 2) / aw, (y + h / 2) / ah, w / aw, h / ah) for (x, y, w, h) in achados]
        saida.append((ini + i * passo, faces))
    return W, H, saida


def plano_vertical(wav, cameras, pessoas, geral, inicio, fim, duracao_minima=2.0):
    import numpy as np
    plano = plano_podcast(wav, cameras, pessoas, geral, 0.5, 0.25, duracao_minima, False)
    pecas = []
    for p in plano["pecas"]:
        a, b = max(p["a"], inicio), min(p["b"], fim)
        if b - a < 0.05:
            continue
        pecas.append({"a": a, "b": b, "camera": p["camera"], "t": a - inicio})
    if not pecas:
        raise RuntimeError("Nenhum trecho do podcast cai nesse intervalo.")
    # no vertical não dá para mostrar o plano geral (3 pessoas lado a lado): onde ele aparece,
    # usa a câmera fechada do trecho vizinho (todas as câmeras estão sincronizadas)
    if any(p["camera"] != geral for p in pecas):
        for i, p in enumerate(pecas):
            if p["camera"] == geral:
                viz = [q["camera"] for q in reversed(pecas[:i]) if q["camera"] != geral] + \
                      [q["camera"] for q in pecas[i + 1:] if q["camera"] != geral]
                p["camera"] = viz[0]
    ultimo = {}
    for p in pecas:
        p["crops"] = {}
        for cam in cameras:  # enquadramento de CADA câmera neste trecho (as não usadas ficam desativadas)
            atraso = plano["atraso"][cam]["valor"]
            W, H, amostras = rostos_no_trecho(cameras[cam], p["a"] + atraso, p["b"] + atraso)
            escolhidos = []
            for _, faces in amostras:
                if not faces:
                    continue
                if cam == geral and len(faces) > 1:  # plano geral: centro do grupo
                    escolhidos.append((float(np.mean([f[0] for f in faces])), float(np.mean([f[1] for f in faces])),
                                       float(max(f[3] for f in faces))))
                else:  # câmera fechada: segue o maior rosto
                    f = max(faces, key=lambda f: f[2] * f[3])
                    escolhidos.append((f[0], f[1], f[3]))
            if escolhidos:
                cx = float(np.median([e[0] for e in escolhidos]))
                cy = float(np.median([e[1] for e in escolhidos]))
                fh = float(np.median([e[2] for e in escolhidos]))
                n = len(escolhidos)
                ultimo[cam] = (cx, cy, fh)
            else:
                cx, cy, fh = ultimo.get(cam, (0.5, 0.4, 0.2))
                n = 0
            p["crops"][cam] = {"largura": W, "altura": H, "cx": cx, "cy": cy, "fh": fh, "rostos": n}
    return {"pecas": pecas, "atraso": plano["atraso"], "duracao": fim - inicio}



# ------------------------------------------------ busca de trechos por assunto

PARADAS = set("""a o as os um uma uns umas de do da dos das em no na nos nas por para com sem
sobre ao aos que e ou mas se ja so eu tu ele ela nos eles elas voce voces meu minha seu sua
quero falas fala trechos trecho parte partes momento momentos onde quando como mais muito
foi ser ter tem tinha esta estao isso isto esse essa aquilo falar falou falando fale""".split())


def _norm(txt):
    import unicodedata
    t = unicodedata.normalize("NFD", str(txt).lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9 ]", " ", t)


def _radical(p):
    return p[:5] if len(p) > 6 else p[:4] if len(p) > 4 else p


def _alternativas(consulta):
    """'perdão, casamento e filhos' -> [[perdao], [casamento], [filhos]] (qualquer uma serve);
    palavras na mesma alternativa (sem vírgula/"e"/"ou") precisam aparecer na mesma frase."""
    saida = []
    for bloco in re.split(r"[,;]|\bou\b|\be\b", str(consulta), flags=re.IGNORECASE):
        termos = [t for t in _norm(bloco).split() if t not in PARADAS and len(t) > 2]
        if termos:
            saida.append(termos)
    return saida



_EMB = {"modelo": None}

def corpo_tem_palavras_chave(consulta):
    """Se a pessoa escreveu so palavras separadas por virgula, usa busca por palavras."""
    return ("," in consulta or ";" in consulta) and len(consulta.split()) <= 8


def _busca_semantica(frases, palavras, consulta, contexto):
    """Busca por SENTIDO (precisa do pacote fastembed). Sem ele, devolve None."""
    try:
        import numpy as np
        from fastembed import TextEmbedding
    except Exception:
        return None
    if _EMB["modelo"] is None:
        _EMB["modelo"] = TextEmbedding("sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
                                       cache_dir=os.path.join(_RAIZ, "modelos"))
    modelo = _EMB["modelo"]
    textos = [" ".join(x["w"] for x in fr) for fr in frases]
    jan = 4
    janelas = [" ".join(textos[i:i + jan]) for i in range(0, max(1, len(textos) - jan + 1))]
    vet = np.array(list(modelo.embed(janelas)))
    q = np.array(list(modelo.embed([consulta])))[0]
    vet = vet / (np.linalg.norm(vet, axis=1, keepdims=True) + 1e-9)
    q = q / (np.linalg.norm(q) + 1e-9)
    sim = vet @ q
    melhor = float(sim.max())
    limiar = max(melhor - 0.10, 0.25)
    usadas = sorted({k for i, v in enumerate(sim) if v >= limiar for k in range(i, min(len(frases), i + jan))})
    if not usadas:
        return {"passagens": [], "frases": len(frases)}
    pico = {}
    for i, v in enumerate(sim):
        for k in range(i, min(len(frases), i + jan)):
            pico[k] = max(pico.get(k, -1), float(v))
    viz = {"curto": 0, "medio": 1, "longo": 2}.get(contexto, 1)
    grupos = []
    for i in usadas:
        if grupos and i - grupos[-1][1] <= 2:
            grupos[-1][1] = i
        else:
            grupos.append([i, i])
    saida = []
    for a_i, b_i in grupos:
        a_i, b_i = max(0, a_i - viz), min(len(frases) - 1, b_i + viz)
        a, b = max(0.0, frases[a_i][0]["s"] - 0.4), frases[b_i][-1]["e"] + 0.4
        if b - a < 8:
            continue
        txt = " ".join(p["w"] for p in palavras if a <= p["s"] < b)
        saida.append({"ini": round(a, 2), "fim": round(b, 2), "acertos": 1,
                      "texto": (txt[:140] + "...") if len(txt) > 140 else txt})
    return {"passagens": saida, "frases": len(frases), "semantica": True,
            "duracao": round(sum(p["fim"] - p["ini"] for p in saida), 1)}

def buscar_trechos(wav, consulta, contexto):
    cache = os.path.splitext(wav)[0] + "_palavras.json"
    if not os.path.isfile(cache):
        raise RuntimeError("Falta a transcrição do podcast. Na aba Legendas, clique em "
                           "'Transcrever o podcast (por palavra)' (só precisa fazer uma vez).")
    import re as _re
    tempos = _re.findall(r"(\d{1,3}):(\d{2})\s*(?:-|a|até|ate)\s*(\d{1,3}):(\d{2})", consulta)
    if tempos:
        passagens = []
        with open(cache, encoding="utf-8") as f:
            pal = json.load(f)
        for a, b, c, d in tempos:
            ini, fim = int(a) * 60 + int(b), int(c) * 60 + int(d)
            txt = " ".join(p["w"] for p in pal if ini <= p["s"] <= fim)
            passagens.append({"ini": float(ini), "fim": float(fim), "acertos": 0, "texto": txt})
        return {"passagens": passagens, "duracao": sum(p["fim"] - p["ini"] for p in passagens)}
    alternativas = _alternativas(consulta)
    if not alternativas:
        raise RuntimeError("Escreva o assunto que você procura (ex.: perdão, casamento).")
    with open(cache, encoding="utf-8") as f:
        palavras = json.load(f)
    # frases: fim com . ? ! ou pausa longa
    frases, atual = [], []
    for p in palavras:
        if atual and p["s"] - atual[-1]["e"] > 1.0:
            frases.append(atual)
            atual = []
        atual.append(p)
        if p["w"][-1:] in ".?!" and len(atual) >= 3:
            frases.append(atual)
            atual = []
    if atual:
        frases.append(atual)
    if not corpo_tem_palavras_chave(consulta):
        sem = _busca_semantica(frases, palavras, consulta, contexto)
        if sem is not None:
            return sem
    radicais_frases = [{_radical(t) for t in _norm(" ".join(x["w"] for x in fr)).split()}
                       for fr in frases]
    acertos = [i for i, rad in enumerate(radicais_frases)
               if any(all(_radical(t) in rad for t in alt) for alt in alternativas)]
    if not acertos:  # relaxa: basta metade das palavras de uma alternativa
        acertos = [i for i, rad in enumerate(radicais_frases)
                   if any(sum(_radical(t) in rad for t in alt) >= max(1, len(alt) // 2)
                          for alt in alternativas)]
    if not acertos:
        return {"passagens": [], "frases": len(frases)}
    viz = {"curto": 0, "medio": 1, "longo": 3}.get(contexto, 1)
    folga = {"curto": 0.3, "medio": 0.6, "longo": 1.0}.get(contexto, 0.6)
    faixas = []
    for i in acertos:
        a_i, b_i = max(0, i - viz), min(len(frases) - 1, i + viz)
        faixas.append([frases[a_i][0]["s"] - folga, frases[b_i][-1]["e"] + folga, i])
    faixas.sort()
    fundidas = []
    for a, b, i in faixas:
        if fundidas and a <= fundidas[-1][1] + 1.0:
            fundidas[-1][1] = max(fundidas[-1][1], b)
            fundidas[-1][2] += 1
        else:
            fundidas.append([max(0.0, a), b, 1])
    saida = []
    for a, b, n in fundidas:
        txt = " ".join(p["w"] for p in palavras if a <= p["s"] < b)
        saida.append({"ini": round(a, 2), "fim": round(b, 2), "acertos": n,
                      "texto": (txt[:140] + "...") if len(txt) > 140 else txt})
    return {"passagens": saida, "frases": len(frases),
            "duracao": round(sum(p["fim"] - p["ini"] for p in saida), 1)}

# --------------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    def _cabecalhos(self, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.end_headers()

    def _responder(self, dados, status=200):
        self._cabecalhos(status)
        self.wfile.write(json.dumps(dados, ensure_ascii=False).encode("utf-8"))

    def do_OPTIONS(self):
        self._cabecalhos(204)

    def do_GET(self):
        if self.path == "/ping":
            self._responder({"ok": True, "versao": VERSAO})
        elif self.path == "/atualizacao/verificar":
            self._responder(verificar_atualizacao())
        elif self.path.startswith("/painel/pacote"):
            try:
                pasta = os.path.join(_RAIZ, "painel")
                html = open(os.path.join(pasta, "index.html"), encoding="utf-8").read()
                js = open(os.path.join(pasta, "main.js"), encoding="utf-8").read()
                import re as _re
                css = "\n".join(_re.findall(r"<style[^>]*>(.*?)</style>", html, _re.S))
                m = _re.search(r"<body[^>]*>(.*)</body>", html, _re.S)
                corpo = _re.sub(r"<script[^>]*src=[^>]*>\s*</script>", "", m.group(1) if m else "")
                self._responder({"ok": True, "versao": VERSAO, "css": css, "corpo": corpo, "js": js})
            except Exception as e:
                self._responder({"erro": "pacote do painel indisponível: " + str(e)}, 500)
        else:
            self._responder({"erro": "rota não encontrada"}, 404)

    def do_POST(self):
        try:
            tamanho = int(self.headers.get("Content-Length", 0))
            corpo = json.loads(self.rfile.read(tamanho) or b"{}")
            caminho = corpo.get("path", "")
            if self.path == "/atualizacao/aplicar":
                res = aplicar_atualizacao()
                self._responder(res)
                if res.get("ok") and res.get("disponivel"):
                    import threading
                    threading.Timer(0.8, _reiniciar_servidor).start()
                return
            if self.path == "/reiniciar":
                self._responder({"ok": True})
                import threading
                threading.Timer(0.6, _reiniciar_servidor).start()
                return
            if self.path == "/listar_mogrts":
                return self._responder({"templates": listar_mogrts()})
            if not os.path.isfile(caminho):
                return self._responder({"erro": f"arquivo não encontrado: {caminho}"}, 400)

            if self.path == "/silences":
                silencios, total = detectar_silencios(
                    caminho,
                    float(corpo.get("noiseDb", -30)),
                    float(corpo.get("minSilence", 0.4)),
                )
                manter = trechos_a_manter(silencios, total, float(corpo.get("padding", 0.1)))
                return self._responder({
                    "duration": total,
                    "silences": silencios,
                    "keep": manter,
                })

            if self.path == "/transcribe":
                existente = os.path.splitext(caminho)[0] + ".srt"
                if corpo.get("reuse") and os.path.isfile(existente):
                    return self._responder({
                        "srt": existente, "segments": len(ler_srt(existente)), "reused": True})
                srt, n = transcrever(
                    caminho,
                    corpo.get("model", "small"),
                    corpo.get("device", "cpu"),
                    corpo.get("language", "pt"),
                )
                return self._responder({"srt": srt, "segments": n})

            if self.path == "/remap":
                srt = os.path.splitext(caminho)[0] + ".srt"
                if not os.path.isfile(srt):
                    return self._responder(
                        {"erro": "Não achei o .srt deste vídeo. Gere as legendas primeiro."}, 400)
                descartadas = []
                falas = reposicionar_falas(ler_srt(srt), corpo.get("segments", []), descartadas)
                sufixo = re.sub(r"[^A-Za-z0-9_-]", "", str(corpo.get("suffix", ""))) or "cortado"
                destino = os.path.splitext(caminho)[0] + "_" + sufixo + ".srt"
                gravar_srt(destino, falas)
                relatorio = os.path.splitext(caminho)[0] + "_descartadas.txt"
                with open(relatorio, "w", encoding="utf-8") as f:
                    f.write("Legendas que ficaram de fora do arquivo _cortado.srt\n")
                    f.write("(tempos do vídeo ORIGINAL)\n\n")
                    if not descartadas:
                        f.write("Nenhuma.\n")
                    for ini, fim, texto, motivo in descartadas:
                        f.write(f"{formatar_tempo_srt(ini)} --> {formatar_tempo_srt(fim)}\n")
                        f.write(f"Motivo: {motivo}\n{texto}\n\n")
                return self._responder({"srt": destino, "segments": len(falas),
                                        "descartadas": len(descartadas)})

            if self.path == "/speakers":
                trechos, tempo, _, _ = quem_fala(
                    corpo["pessoas"], caminho,
                    float(corpo.get("janela", 0.1)),
                    float(corpo.get("margemDb", 6.0)),
                    float(corpo.get("acimaRuidoDb", 12.0)),
                    float(corpo.get("duracaoMinima", 2.0)),
                )
                return self._responder({"trechos": trechos, "tempo": tempo})

            if self.path == "/legendas_podcast":
                return self._responder(legendas_podcast(
                    caminho, corpo["pessoas"], corpo.get("model", "small"),
                    corpo.get("device", "cpu"), corpo.get("language", "pt"),
                    bool(corpo.get("reuse", True))))

            if self.path == "/palavras_trecho":
                cache, n, de_cache = palavras_do_trecho(
                    caminho, float(corpo.get("inicio", 0)), float(corpo.get("fim", 60)),
                    corpo.get("model", "small"), corpo.get("device", "cpu"), corpo.get("language", "pt"))
                return self._responder({"cache": cache, "palavras": n, "reaproveitou": de_cache})

            if self.path == "/legendas_estilizadas":
                pasta = corpo.get("pastaSaida") or os.path.join(
                    os.path.dirname(os.path.abspath(__file__)), "..", "mogrts")
                return self._responder({"legendas": legendas_estilizadas(
                    caminho, float(corpo.get("inicio", 0)), float(corpo.get("fim", 1e9)),
                    corpo.get("modo", "curtas"), corpo.get("estilo", "aleatorio"),
                    os.path.normpath(pasta), bool(corpo.get("enxuto", False)),
                    corpo.get("semente", 1), corpo.get("cache"), corpo.get("prefixo", ""))})

            if self.path == "/plano_vertical":
                for o in corpo["cameras"].values():
                    if not os.path.isfile(o):
                        return self._responder({"erro": f"arquivo não encontrado: {o}"}, 400)
                return self._responder(plano_vertical(
                    caminho, corpo["cameras"], corpo["pessoas"], corpo.get("geral", "V1"),
                    float(corpo.get("inicio", 0)), float(corpo.get("fim", 60)),
                    float(corpo.get("duracaoMinima", 2.0))))

            if self.path == "/plano_podcast":
                for o in corpo["cameras"].values():
                    if not os.path.isfile(o):
                        return self._responder({"erro": f"arquivo não encontrado: {o}"}, 400)
                return self._responder(plano_podcast(
                    caminho, corpo["cameras"], corpo["pessoas"], corpo.get("geral", "V1"),
                    float(corpo.get("minimo", 0.5)), float(corpo.get("respiro", 0.25)),
                    float(corpo.get("duracaoMinima", 2.0)),
                    bool(corpo.get("cortarSilencios", False)), corpo.get("faixas"),
                    corpo.get("apresentadores") or corpo.get("apresentador"), int(corpo.get("prioridade", 0))))

            if self.path == "/buscar":
                return self._responder(buscar_trechos(
                    caminho, corpo.get("consulta", ""), corpo.get("contexto", "medio")))

            if self.path == "/sync":
                outros = corpo.get("outros", [])
                for o in outros:
                    if not os.path.isfile(o):
                        return self._responder({"erro": f"arquivo não encontrado: {o}"}, 400)
                res = deslocamentos(caminho, outros)
                return self._responder({"resultados": [
                    {"arquivo": o, "deslocamento": d, "confianca": c}
                    for o, (d, c) in zip(outros, res)]})

            self._responder({"erro": "rota não encontrada"}, 404)
        except Exception as e:  # devolve o erro para o painel mostrar
            import traceback
            traceback.print_exc()  # mostra o erro completo na janela do servidor
            self._responder({"erro": str(e)}, 500)

    def log_message(self, formato, *args):
        print("[podcast-pro]", formato % args)


def _versao_tupla(v):
    try:
        return tuple(int(x) for x in str(v).split("."))
    except Exception:
        return (0,)


def _baixar(nome):
    import urllib.request, time
    req = urllib.request.Request(URL_ATUALIZACAO + nome + "?t=" + str(int(time.time())), headers={"User-Agent": "podcast-pro"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def verificar_atualizacao():
    try:
        info = json.loads(_baixar("versao.json").decode("utf-8"))
    except Exception as e:
        return {"ok": False, "erro": "Não consegui falar com o endereço das atualizações: " + str(e)}
    nova = info.get("versao", "0")
    return {"ok": True, "atual": VERSAO, "nova": nova, "disponivel": _versao_tupla(nova) > _versao_tupla(VERSAO), "notas": info.get("notas", "")}


def aplicar_atualizacao():
    """Baixa os arquivos novos, confere a integridade, guarda cópia dos antigos e troca."""
    import hashlib, shutil
    info = json.loads(_baixar("versao.json").decode("utf-8"))
    if _versao_tupla(info.get("versao", "0")) <= _versao_tupla(VERSAO):
        return {"ok": True, "disponivel": False}
    destinos = {
        "server.py": os.path.abspath(__file__),
        "painel_index.html": os.path.join(_RAIZ, "painel", "index.html"),
        "painel_main.js": os.path.join(_RAIZ, "painel", "main.js"),
    }
    novos = {}
    for nome, sha in (info.get("arquivos") or {}).items():
        if nome not in destinos:
            continue
        dados = _baixar(nome)
        if hashlib.sha256(dados).hexdigest().lower() != str(sha).lower():
            return {"ok": False, "erro": "O arquivo " + nome + " veio corrompido. Nada foi alterado. Tente de novo."}
        novos[nome] = dados
    if not novos:
        return {"ok": False, "erro": "O pacote de atualização está vazio."}
    if "server.py" in novos:
        try:
            compile(novos["server.py"].decode("utf-8"), "server.py", "exec")
        except Exception as e:
            return {"ok": False, "erro": "O programa novo tem erro e não foi instalado: " + str(e)}
    pasta_bkp = os.path.join(_RAIZ, "backup")
    os.makedirs(pasta_bkp, exist_ok=True)
    for nome, dados in novos.items():
        dest = destinos[nome]
        if os.path.exists(dest):
            shutil.copy2(dest, os.path.join(pasta_bkp, nome + ".bak"))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest + ".novo", "wb") as f:
            f.write(dados)
        os.replace(dest + ".novo", dest)
    return {"ok": True, "disponivel": True, "nova": info.get("versao")}


def _reiniciar_servidor():
    """Liga o servidor de novo (lê o server.py atualizado), sem precisar fechar nada."""
    try:
        sys.stdout.flush()
    except Exception:
        pass
    os.execv(sys.executable, [sys.executable, os.path.abspath(__file__)])


if __name__ == "__main__":
    print(f"PODCAST PRO rodando em http://{HOST}:{PORT}  (Ctrl+C para parar)")
    import time
    servidor = None
    for _ in range(40):  # ao reiniciar, a porta pode levar um instante para liberar
        try:
            servidor = ThreadingHTTPServer((HOST, PORT), Handler)
            break
        except OSError:
            time.sleep(0.5)
    if servidor is None:
        raise SystemExit("A porta 8765 está ocupada por outro programa.")
    servidor.serve_forever()
