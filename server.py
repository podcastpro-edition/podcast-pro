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
import threading
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
VERSAO = "1.0.97"
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


def _recorte_ok(recorte, total):
    """[ini, fim] em segundos -> (ini, fim), ou None se for o arquivo inteiro / inválido."""
    if not recorte:
        return None
    try:
        a, b = float(recorte[0]), float(recorte[1])
    except Exception:
        return None
    a, b = max(0.0, a), min(total, b)
    if b - a < 1.0 or (a < 1.0 and b > total - 1.0):
        return None
    return (a, b)


def _env_camera(caminho, ini, dur, lag, n):
    """Volume (dB, a cada 0,1 s) do áudio de uma câmera, alinhado ao relógio do gravador:
    começa em 'ini' do gravador (a câmera está 'lag' segundos adiante). Devolve n valores."""
    import numpy as np

    inicio = ini + lag
    antes = 0
    if inicio < 0:
        antes = int(round(-inicio / 0.1))
        inicio = 0.0
    x = ler_canal(caminho, None, 8000, inicio, max(1.0, dur - antes * 0.1 + 0.5))
    e = envelope_db(x, 8000, 0.1)
    e = np.concatenate([np.full(antes, e.min() if len(e) else -90.0), e])
    if len(e) < n:
        e = np.pad(e, (0, n - len(e)), constant_values=e.min() if len(e) else -90.0)
    return e[:n]


def quem_fala(pessoas, caminho, janela=0.1, margem_db=6.0, acima_ruido_db=12.0,
              duracao_minima=2.0, recorte=None):
    """pessoas: [{nome, canal, camera}]. Devolve (trechos, tempo_por_pessoa).
    Cada trecho: {ini, fim, quem, camera}. 'quem' = nome ou 'geral'."""
    import numpy as np

    rec = _recorte_ok(recorte, duracao_total(caminho))
    desloc = rec[0] if rec else 0.0
    envs = []
    for p in pessoas:
        x = ler_canal(caminho, p["canal"], 8000, rec[0] if rec else 0.0, (rec[1] - rec[0]) if rec else None)
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
        saida.append({"ini": round(ini * janela + desloc, 2), "fim": round(fim * janela + desloc, 2),
                      "quem": nome, "camera": None if r < 0 else pessoas[r]["camera"]})
    ativo_geral = ativo.any(axis=0)
    if desloc:
        ativo_geral = np.concatenate([np.ones(int(round(desloc / janela)), dtype=bool), ativo_geral])
    return saida, tempo, ativo_geral, janela


# --------------------------------------- vozes em uma trilha só (sem microfone separado)

def _mfcc(x, taxa=16000, n_mel=26, n_coef=20):
    """MFCC simples em numpy. Devolve (coeficientes por quadro, energia dB por quadro)."""
    import numpy as np

    tam, passo = int(0.025 * taxa), int(0.010 * taxa)
    if len(x) < tam + passo:
        return np.zeros((0, n_coef)), np.zeros(0)
    n = 1 + (len(x) - tam) // passo
    idx = np.arange(tam)[None, :] + passo * np.arange(n)[:, None]
    q = x[idx] * np.hamming(tam)[None, :]
    energia = 10 * np.log10((q ** 2).mean(axis=1) + 1e-10)
    nfft = 512
    esp = np.abs(np.fft.rfft(q, nfft, axis=1)) ** 2
    mel = lambda f: 2595 * np.log10(1 + f / 700.0)
    imel = lambda m: 700 * (10 ** (m / 2595.0) - 1)
    pontos = imel(np.linspace(mel(80), mel(taxa / 2 * 0.95), n_mel + 2))
    bins = np.floor((nfft + 1) * pontos / taxa).astype(int)
    fb = np.zeros((n_mel, nfft // 2 + 1))
    for m in range(1, n_mel + 1):
        a, b, c = bins[m - 1], bins[m], bins[m + 1]
        for k in range(a, b):
            fb[m - 1, k] = (k - a) / max(1, b - a)
        for k in range(b, c):
            fb[m - 1, k] = (c - k) / max(1, c - b)
    logmel = np.log(esp @ fb.T + 1e-10)
    k = np.arange(n_mel)
    dct = np.cos(np.pi / n_mel * (k[None, :] + 0.5) * np.arange(n_coef)[:, None])
    return logmel @ dct.T, energia


def _f0_mediano(x, taxa=16000):
    """Altura média da voz (Hz) de um pedaço de áudio, por autocorrelação; 0 se não achar."""
    import numpy as np

    tam, passo = int(0.04 * taxa), int(0.02 * taxa)
    vals = []
    lo, hi = int(taxa / 400), int(taxa / 70)
    for i in range(0, len(x) - tam, passo):
        q = x[i:i + tam] - x[i:i + tam].mean()
        if (q ** 2).mean() < 1e-7:
            continue
        ac = np.correlate(q, q, "full")[tam - 1:]
        if ac[0] <= 0:
            continue
        k = lo + int(np.argmax(ac[lo:hi]))
        if ac[k] / ac[0] > 0.4:
            vals.append(taxa / k)
    return float(np.median(vals)) if len(vals) >= 3 else 0.0


def _kmeans(X, k, tentativas=8, semente=1):
    import numpy as np

    rng = np.random.default_rng(semente)
    melhor, melhor_custo = None, 1e30
    for _ in range(tentativas):
        c = [X[rng.integers(len(X))]]
        for _ in range(1, k):
            d = np.min(((X[:, None, :] - np.array(c)[None]) ** 2).sum(axis=2), axis=1)
            c.append(X[rng.choice(len(X), p=d / d.sum())] if d.sum() > 0 else X[rng.integers(len(X))])
        c = np.array(c)
        for _ in range(40):
            rot = np.argmin(((X[:, None, :] - c[None]) ** 2).sum(axis=2), axis=1)
            novo = np.array([X[rot == j].mean(axis=0) if (rot == j).any() else c[j] for j in range(k)])
            if np.allclose(novo, c):
                break
            c = novo
        rot = np.argmin(((X[:, None, :] - c[None]) ** 2).sum(axis=2), axis=1)
        custo = sum(((X[rot == j] - c[j]) ** 2).sum() for j in range(k))
        if custo < melhor_custo:
            melhor, melhor_custo = rot, custo
    return melhor


def _silhueta(X, rot):
    """Quão separados estão os grupos (-1 a 1; acima de ~0,25 = bem separados)."""
    import numpy as np

    ks = np.unique(rot)
    if len(ks) < 2:
        return -1.0
    d = np.sqrt(((X[:, None, :] - X[None, :, :]) ** 2).sum(axis=2))
    sil = []
    for i in range(len(X)):
        mesmo = rot == rot[i]
        a = d[i, mesmo].sum() / max(1, mesmo.sum() - 1)
        b = min(d[i, rot == k].mean() for k in ks if k != rot[i])
        sil.append((b - a) / max(a, b, 1e-9))
    return float(np.mean(sil))


def vozes_na_trilha(caminho, n_vozes, duracao_minima=1.5, taxa=16000, janela=1.2, passo=0.6, canal=None, recorte=None):
    """Separa as vozes de uma trilha só pelo timbre e pela altura da voz.
    Devolve {"trechos":[{ini,fim,voz}], "tempo":{voz:segundos}, "janela":0.1}.
    As vozes são numeradas 0..n-1 na ordem em que aparecem."""
    import numpy as np

    rec = _recorte_ok(recorte, duracao_total(caminho))
    desloc = rec[0] if rec else 0.0
    x = ler_canal(caminho, canal, taxa, rec[0] if rec else 0.0, (rec[1] - rec[0]) if rec else None)
    coef, energia = _mfcc(x, taxa)
    if len(coef) == 0:
        raise RuntimeError("áudio curto demais para separar as vozes")
    limite = min(np.percentile(energia, 5) + 10, np.percentile(energia, 95) - 15)
    voz_ativa = energia > limite
    qj, qp = int(janela * 100), int(passo * 100)
    feats, tempos = [], []
    for i in range(0, len(coef) - qj, qp):
        m = voz_ativa[i:i + qj]
        if m.mean() < 0.4:
            continue
        c = coef[i:i + qj][m][:, 1:]
        a, b = int(i * 0.01 * taxa), int((i + qj) * 0.01 * taxa)
        f0 = _f0_mediano(x[a:b], taxa)
        feats.append(np.concatenate([c.mean(axis=0), [np.log(f0) * 3.0 if f0 > 0 else np.nan]]))
        tempos.append(i * 0.01)
    feats = np.array(feats)
    if len(feats) < max(6, 2 * n_vozes):
        raise RuntimeError("pouca fala para separar as vozes")
    col = feats[:, -1]
    col[np.isnan(col)] = np.nanmedian(col) if np.isfinite(np.nanmedian(col)) else 0.0
    feats = (feats - feats.mean(axis=0)) / (feats.std(axis=0) + 1e-6)
    rot = _kmeans(feats, max(1, int(n_vozes))) if n_vozes > 1 else np.zeros(len(feats), dtype=int)
    # quantas vozes parecem existir de verdade? (o painel avisa se forem mais do que as pessoas listadas)
    k_sugerido = int(n_vozes)
    try:
        amostra = feats if len(feats) <= 1200 else feats[np.random.default_rng(0).choice(len(feats), 1200, replace=False)]
        melhor, melhor_nota = None, 0.0
        for k in range(2, 7):
            nota = _silhueta(amostra, _kmeans(amostra, k, tentativas=4))
            if nota > melhor_nota:
                melhor, melhor_nota = k, nota
        if melhor and melhor_nota >= 0.2 and melhor > int(n_vozes):
            k_sugerido = melhor
    except Exception:
        pass
    # suaviza (mediana de 5 janelas)
    sua = rot.copy()
    for i in range(len(rot)):
        viz = rot[max(0, i - 2): i + 3]
        sua[i] = np.bincount(viz).argmax()
    # renumera pela ordem de aparição
    ordem = {}
    for r in sua:
        ordem.setdefault(int(r), len(ordem))
    sua = np.array([ordem[int(r)] for r in sua])

    janelas_01 = int(round(len(x) / taxa / 0.1))
    lab = np.full(janelas_01, -1, dtype=int)
    for t, r in zip(tempos, sua):
        a = int(t / 0.1); b = min(janelas_01, int((t + janela) / 0.1))
        lab[a:b] = int(r)
    ult = None
    for i in range(janelas_01):  # silêncio mantém quem falava
        if lab[i] < 0:
            if ult is not None:
                lab[i] = ult
        else:
            ult = lab[i]
    prim = next((v for v in lab if v >= 0), 0)
    lab[lab < 0] = prim
    trechos, ini = [], 0
    for i in range(1, len(lab) + 1):
        if i == len(lab) or lab[i] != lab[ini]:
            trechos.append([ini, i, int(lab[ini])]); ini = i
    minimo = int(round(duracao_minima / 0.1))
    while len(trechos) > 1:
        k = min(range(len(trechos)), key=lambda j: trechos[j][1] - trechos[j][0])
        if trechos[k][1] - trechos[k][0] >= minimo:
            break
        if k == 0:
            v = 1
        elif k == len(trechos) - 1:
            v = k - 1
        else:
            v = k - 1 if (trechos[k - 1][1] - trechos[k - 1][0]) >= (trechos[k + 1][1] - trechos[k + 1][0]) else k + 1
        trechos[k][2] = trechos[v][2]
        fund = [trechos[0]]
        for t in trechos[1:]:
            if t[2] == fund[-1][2]:
                fund[-1][1] = t[1]
            else:
                fund.append(t)
        trechos = fund
    tempo, saida = {}, []
    for a, b, v in trechos:
        tempo[v] = tempo.get(v, 0.0) + (b - a) * 0.1
        saida.append({"ini": round(a * 0.1 + desloc, 2), "fim": round(b * 0.1 + desloc, 2), "voz": int(v)})
    return {"trechos": saida, "tempo": {str(k): round(v, 1) for k, v in tempo.items()}, "kSugerido": k_sugerido}


def ligar_vozes_as_pessoas(res_vozes, wav, pessoas, cameras, recorte=None):
    """Tenta descobrir sozinho qual voz é de qual pessoa, comparando quando cada voz fala com o
    volume do áudio de cada câmera (a câmera de quem fala costuma captar mais essa voz).
    pessoas: [{nome, camera}]; cameras: {"V2": caminho}. Devolve {"mapa": {voz: nome|None},
    "confiavel": bool, "amostras": {voz: [segundos...]}}."""
    import numpy as np
    from itertools import permutations

    trechos = res_vozes["trechos"]
    vozes = sorted({t["voz"] for t in trechos})
    amostras = {}
    for v in vozes:
        mais_longos = sorted((t for t in trechos if t["voz"] == v), key=lambda t: t["ini"] - t["fim"])[:3]
        amostras[v] = sorted(round(t["ini"], 1) for t in mais_longos)
    resposta = {"mapa": {v: None for v in vozes}, "confiavel": False, "amostras": amostras}
    cams = sorted({p["camera"] for p in pessoas if p["camera"] in cameras})
    if len(vozes) < 2 or len(cams) < 2:
        return resposta
    rec = _recorte_ok(recorte, duracao_total(wav))
    t0 = rec[0] if rec else 0.0
    n = int(round((max(t["fim"] for t in trechos) - t0) / 0.1))
    base = {}
    try:
        lags = deslocamentos(wav, [cameras[c] for c in cams])
        for c, (lag, _conf) in zip(cams, lags):
            e = _env_camera(cameras[c], t0, n * 0.1, lag, n)
            base[c] = (e - e.mean()) / (e.std() + 1e-6)
    except Exception:
        return resposta
    lab = np.full(n, -1)
    for t in trechos:
        lab[int(round((t["ini"] - t0) / 0.1)): int(round((t["fim"] - t0) / 0.1))] = t["voz"]
    pontos = {}
    for v in vozes:
        em = lab == v
        for c in cams:
            fora = base[c][~em].mean() if (~em).any() else 0.0
            pontos[(v, c)] = float(base[c][em].mean() - fora) if em.any() else 0.0
    # escolhe a melhor combinação voz -> pessoa (cada pessoa recebe no máximo uma voz)
    quantas = min(len(vozes), len(pessoas))
    melhores = []
    for perm in permutations(range(len(pessoas)), quantas):
        tot = sum(pontos.get((v, pessoas[i]["camera"]), 0.0) for v, i in zip(vozes, perm))
        melhores.append((tot, perm))
    melhores.sort(key=lambda z: -z[0])
    if not melhores:
        return resposta
    tot1, perm1 = melhores[0]
    tot2 = melhores[1][0] if len(melhores) > 1 else tot1 - 1
    cams_pessoas = [pessoas[i]["camera"] for i in perm1]
    unicas = len(set(cams_pessoas)) == len(cams_pessoas)
    fortes = all(pontos.get((v, pessoas[i]["camera"]), 0.0) > 0.15 for v, i in zip(vozes, perm1))
    margem = (tot1 - tot2) / (abs(tot1) + 1e-6)
    for v, i in zip(vozes, perm1):
        resposta["mapa"][v] = pessoas[i]["nome"]
    resposta["confiavel"] = bool(unicas and fortes and margem > 0.25 and quantas == len(pessoas))
    resposta["margem"] = round(float(margem), 2)
    return resposta


# ----------------------------------------- escolher sozinho o melhor áudio da sequência

_CACHE_ANALISE = {}


def _chave_cache(nome, args, kw):
    """Chave que muda se qualquer arquivo envolvido mudar (tamanho/data) ou se qualquer ajuste mudar."""
    import json as _j
    arquivos = set()

    def varre(x):
        if isinstance(x, str) and os.path.isfile(x):
            arquivos.add(x)
        elif isinstance(x, dict):
            for v in x.values():
                varre(v)
        elif isinstance(x, (list, tuple)):
            for v in x:
                varre(v)
    varre(args)
    varre(kw)
    sel = []
    for a in sorted(arquivos):
        try:
            st = os.stat(a)
            sel.append((a, st.st_size, int(st.st_mtime)))
        except OSError:
            sel.append((a, 0, 0))
    return nome + _j.dumps([args, kw, sel], sort_keys=True, default=str)


def com_cache(f):
    """Guarda o resultado da análise pesada: repetir com os mesmos arquivos e ajustes devolve na hora."""
    import copy

    def g(*args, **kw):
        k = _chave_cache(f.__name__, args, kw)
        if k in _CACHE_ANALISE:
            return copy.deepcopy(_CACHE_ANALISE[k])
        r = f(*args, **kw)
        if len(_CACHE_ANALISE) > 12:
            _CACHE_ANALISE.clear()
        _CACHE_ANALISE[k] = copy.deepcopy(r)
        return r
    g.__name__ = f.__name__
    return g


def avaliar_audios(faixas, cameras, pessoas, recorte=None):
    """faixas: [{trilha, path}] (uma por trilha de áudio da sequência, 0 = A1).
    cameras: {"V1": caminho}. pessoas: [{nome, camera}].
    Classifica cada trilha (câmera/ambiente, vazia, efeitos, master, microfone) e propõe:
    - modo "microfones": um microfone por pessoa (ligado pela câmera em que ela aparece), ou
    - modo "voz_unica": usar a trilha master (ou a melhor trilha com fala)."""
    import numpy as np
    from itertools import permutations

    norm = lambda c: os.path.normcase(os.path.abspath(c))
    rec = _recorte_ok(recorte, duracao_total(faixas[0]["path"])) if faixas else None
    t0 = rec[0] if rec else 0.0
    dur_an = min(600.0, (rec[1] - rec[0])) if rec else 600.0
    de_camera = {norm(c) for c in cameras.values()}
    grupos, canal_de = {}, {}
    for f in faixas:
        lista = grupos.setdefault(norm(f["path"]), [])
        canal_de[f["trilha"]] = len(lista)
        lista.append(f["trilha"])

    info, envs = [], {}
    for f in faixas:
        t = f["trilha"]
        item = {"trilha": t, "path": f["path"], "canal": canal_de[t]}
        if norm(f["path"]) in de_camera:
            item["tipo"] = "camera"
            info.append(item)
            continue
        try:
            e = envelope_db(ler_canal(f["path"], canal_de[t], 8000, t0, dur_an), 8000, 0.1)
        except Exception:
            item["tipo"] = "vazia"
            info.append(item)
            continue
        chao = float(np.percentile(e, 10))
        topo = float(np.percentile(e, 95))
        limiar = min(chao + 12, topo - 12)  # fala contínua (sem pausas) também conta como fala
        item["nivel"] = round(topo, 1)
        item["cobertura"] = round(float((e > limiar).mean()), 3)
        if item["nivel"] < -50:
            item["tipo"] = "vazia"
        elif item["cobertura"] < 0.15:
            item["tipo"] = "efeitos"
        else:
            item["tipo"] = "fala"
            envs[t] = (e, limiar)
        info.append(item)

    falas = [i for i in info if i["tipo"] == "fala"]
    master = None
    misturas = []
    if len(falas) >= 3:
        # "mistura" = trilha que tem fala em (quase) todos os momentos em que QUALQUER outra tem
        # e fala bem mais tempo que a trilha típica: é a master ou um ambiente com todas as vozes.
        n = min(len(envs[i["trilha"]][0]) for i in falas)
        ativos = {i["trilha"]: envs[i["trilha"]][0][:n] > envs[i["trilha"]][1] for i in falas}
        mediana = float(np.percentile([i["cobertura"] for i in falas], 25))
        for cand in falas:
            uniao = np.zeros(n, dtype=bool)
            for o in falas:
                if o is not cand:
                    uniao |= ativos[o["trilha"]]
            if uniao.any() and ativos[cand["trilha"]][uniao].mean() >= 0.85 and cand["cobertura"] >= 1.2 * mediana:
                misturas.append(cand)
        if misturas:
            master = max(misturas, key=lambda i: (i["cobertura"], i["nivel"]))
            for m in misturas:
                if m is not master:
                    m["tipo"] = "mistura"
    if master:
        master["tipo"] = "master"
    mics = [i for i in falas if i is not master and i not in misturas]
    for m in mics:
        m["tipo"] = "microfone"
    # microfone de verdade = em algum momento é a trilha mais forte (a pessoa fala nele). Trilhas
    # de ambiente/mistura quase nunca "dominam" e não contam como pessoa.
    if len(mics) >= 3:
        nn = min(len(envs[m["trilha"]][0]) for m in mics)
        mat = np.vstack([envs[m["trilha"]][0][:nn] for m in mics])
        prov = []
        for mi, m in enumerate(mics):
            outros_max = np.max(np.delete(mat, mi, axis=0), axis=0)
            dom = (mat[mi] > envs[m["trilha"]][1]) & (mat[mi] - outros_max > 6)
            m["dominancia"] = round(float(dom.mean()), 3)
            if m["dominancia"] >= 0.05:
                prov.append(m)
        if len(prov) >= max(2, len(pessoas)):
            for m in mics:
                if m not in prov:
                    m["tipo"] = "ambiente"
            mics = prov

    res = {"faixas": [{k: v for k, v in i.items() if k != "path"} for i in info],
           "master": master["trilha"] if master else None,
           "mics": [m["trilha"] for m in mics], "modo": None, "escolha": {}, "confiavel": False}
    n_pessoas = len(pessoas)

    if len(mics) >= max(2, n_pessoas) and n_pessoas >= 1:
        if n_pessoas == 1:
            melhor = max(mics, key=lambda m: m["cobertura"])
            res.update(modo="microfones", escolha={pessoas[0]["nome"]: melhor["trilha"]}, confiavel=True)
            return res
        # liga cada pessoa a um microfone: o microfone domina quando a pessoa fala
        # e a câmera dela capta mais som nesse momento
        cams = sorted({p["camera"] for p in pessoas if p["camera"] in cameras})
        n = min(len(envs[m["trilha"]][0]) for m in mics)
        pontos = {}
        try:
            ref = next(i["path"] for i in info if i["trilha"] == mics[0]["trilha"])
            lags = deslocamentos(ref, [cameras[c] for c in cams])
            base = {}
            for c, (lag, _) in zip(cams, lags):
                e = _env_camera(cameras[c], t0, n * 0.1, lag, n)
                base[c] = (e - e.mean()) / (e.std() + 1e-6)
            matriz = np.vstack([envs[m["trilha"]][0][:n] for m in mics])
            for mi, m in enumerate(mics):
                outros_max = np.max(np.delete(matriz, mi, axis=0), axis=0) if len(mics) > 1 else np.full(n, -200.0)
                dom = (matriz[mi] > envs[m["trilha"]][1]) & (matriz[mi] - outros_max > 6)
                for c in cams:
                    pontos[(mi, c)] = float(base[c][dom].mean() - base[c][~dom].mean()) if dom.any() and (~dom).any() else 0.0
        except Exception:
            pontos = {}
        quantas = min(len(mics), n_pessoas)
        melhores = []
        for perm in permutations(range(len(mics)), quantas):  # perm[k] = microfone da pessoa k
            tot = sum(pontos.get((perm[k], pessoas[k]["camera"]), 0.0) for k in range(quantas))
            melhores.append((tot, perm))
        melhores.sort(key=lambda z: -z[0])
        tot1, perm1 = melhores[0]
        tot2 = melhores[1][0] if len(melhores) > 1 else tot1 - 1
        cam_unicas = len({p["camera"] for p in pessoas}) == n_pessoas
        fortes = bool(pontos) and all(pontos.get((perm1[k], pessoas[k]["camera"]), 0.0) > 0.15 for k in range(quantas))
        margem = (tot1 - tot2) / (abs(tot1) + 1e-6)
        res["modo"] = "microfones"
        res["escolha"] = {pessoas[k]["nome"]: mics[perm1[k]]["trilha"] for k in range(quantas)}
        res["confiavel"] = bool(cam_unicas and fortes and margem > 0.25 and quantas == n_pessoas)
        return res

    unica = master or (max(falas, key=lambda i: i["cobertura"]) if falas else None)
    if unica:
        res.update(modo="voz_unica", escolha={"trilha": unica["trilha"]}, confiavel=True)
    return res


# ------------------------------------------------ equalizar o volume das vozes

def _rms_fala_db(env, limiar, ativo=None):
    """Volume médio (dB) só nos momentos de fala. env = dB por 0,1 s."""
    import numpy as np

    m = env > limiar
    if ativo is not None and (m & ativo).sum() >= 10:
        m = m & ativo
    if not m.any():
        return float(np.percentile(env, 95))
    return float(10 * np.log10(np.mean(10 ** (env[m] / 10.0)) + 1e-12))


def equalizar_audio(caminho, saida, canais=None, canal=None, trechos=None, recorte=None,
                    alvo_db=-20.0, limite_db=(-12.0, 24.0)):
    """Gera um áudio novo em que todas as vozes têm o mesmo volume (nada no original muda).
    - Microfones separados: passe 'canais' (um por pessoa); sai um arquivo só com esses canais, na
      mesma ordem, cada um com o seu ganho.
    - Trilha única: passe 'canal' e 'trechos' [{ini, fim, quem}]; o ganho muda a cada pessoa.
    O arquivo cobre só o recorte (com 1 s de folga); 'offset' diz onde ele começa no original."""
    import numpy as np

    total = duracao_total(caminho)
    rec = _recorte_ok(recorte, total)
    ini = max(0.0, rec[0] - 1.0) if rec else 0.0
    fim = min(total, rec[1] + 1.0) if rec else total
    dur = fim - ini
    os.makedirs(os.path.dirname(saida), exist_ok=True)
    lo, hi = limite_db

    if trechos:  # trilha única, ganho por pessoa
        env = envelope_db(ler_canal(caminho, canal, 8000, ini, dur), 8000, 0.1)
        limiar = min(float(np.percentile(env, 10)) + 12, float(np.percentile(env, 95)) - 30)
        quem = [None] * len(env)
        for t in trechos:
            a, b = int(round((t["ini"] - ini) / 0.1)), int(round((t["fim"] - ini) / 0.1))
            for i in range(max(0, a), min(len(env), b)):
                quem[i] = t["quem"]
        nomes = sorted({q for q in quem if q})
        ganho = {}
        for nome in nomes:
            m = np.array([q == nome for q in quem])
            ganho[nome] = float(np.clip(alvo_db - _rms_fala_db(env, limiar, m), lo, hi))
        curva = np.zeros(len(env))
        ult = 0.0
        for i, q in enumerate(quem):
            if q:
                ult = ganho[q]
            curva[i] = ult
        k = 3  # suaviza a troca de ganho (~0,3 s)
        curva = np.convolve(np.pad(curva, (k, k), mode="edge"), np.ones(2 * k + 1) / (2 * k + 1), mode="valid")
        taxa = 48000
        x = ler_canal(caminho, canal, taxa, ini, dur)
        centros = (np.arange(len(curva)) + 0.5) * 0.1
        g = 10 ** (np.interp(np.arange(len(x)) / taxa, centros, curva) / 20.0)
        y = (x * g).astype(np.float32)
        r = subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "f32le", "-ar", str(taxa),
                            "-ac", "1", "-i", "-", "-af", "alimiter=limit=0.97", "-c:a", "pcm_s24le", saida],
                           input=y.tobytes(), capture_output=True)
        if r.returncode != 0:
            raise RuntimeError("FFmpeg não gravou o áudio: " + r.stderr.decode("utf-8", "replace")[-300:])
        return {"arquivo": saida, "offset": ini, "mapa": {str(canal): 0}, "ganhos": {k: round(v, 1) for k, v in ganho.items()}}

    canais = list(dict.fromkeys(int(c) for c in canais))
    envs = [envelope_db(ler_canal(caminho, c, 8000, ini, dur), 8000, 0.1) for c in canais]
    n = min(len(e) for e in envs)
    envs = [e[:n] for e in envs]
    ganho = {}
    for i, c in enumerate(canais):
        limiar = min(float(np.percentile(envs[i], 10)) + 12, float(np.percentile(envs[i], 95)) - 30)
        dominante = None
        if len(envs) > 1:
            outros = np.max(np.vstack([envs[j] for j in range(len(envs)) if j != i]), axis=0)
            dominante = (envs[i] - outros) > 6
        ganho[c] = float(np.clip(alvo_db - _rms_fala_db(envs[i], limiar, dominante), lo, hi))
    pan = "pan=%dc|" % len(canais) + "|".join("c%d=%.4f*c%d" % (i, 10 ** (ganho[c] / 20.0), c) for i, c in enumerate(canais))
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
    if ini:
        cmd += ["-ss", "%.3f" % ini]
    cmd += ["-t", "%.3f" % dur, "-i", caminho, "-af", pan + ",alimiter=limit=0.97", "-c:a", "pcm_s24le", saida]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError("FFmpeg não gravou o áudio: " + r.stderr.decode("utf-8", "replace")[-300:])
    return {"arquivo": saida, "offset": ini, "mapa": {str(c): i for i, c in enumerate(canais)},
            "ganhos": {str(c): round(g, 1) for c, g in ganho.items()}}


# ----------------------------------- defeitos de câmera (tremida, chicote, desfoque)

SENSIBILIDADE_CAMERA = {"baixa": 1.6, "media": 1.0, "alta": 0.65}


def defeitos_camera(caminho, ini, fim, sensibilidade="media", fps=10, largura=320):
    """Procura momentos ruins no vídeo de uma câmera, no intervalo [ini, fim] (tempo do arquivo).
    Devolve [{"a","b","tipo"}]: 'chicote' (movimento brusco do quadro), 'tremida' (balanço repetido)
    e 'desfoque' (perda de nitidez). Mede o movimento do quadro inteiro, não o das pessoas."""
    import numpy as np
    try:
        import cv2
    except ImportError:
        raise RuntimeError("Falta a biblioteca de imagem (cv2). Rode o INSTALAR.bat de novo.")
    k = SENSIBILIDADE_CAMERA.get(str(sensibilidade).lower(), 1.0)
    W, H = tamanho_video(caminho)
    aw = largura
    ah = int(round(H * aw / W / 2.0)) * 2
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
    if ini > 0:
        cmd += ["-ss", f"{ini:.3f}"]
    cmd += ["-t", f"{max(0.5, fim - ini):.3f}", "-i", caminho, "-an",
            "-vf", f"fps={fps},scale={aw}:{ah},format=gray", "-f", "rawvideo", "-"]
    bruto = subprocess.run(cmd, capture_output=True).stdout
    tam = aw * ah
    n = len(bruto) // tam
    if n < fps * 2:
        return []
    quadros = np.frombuffer(bruto[: n * tam], dtype=np.uint8).reshape(n, ah, aw)
    janela = cv2.createHanningWindow((aw, ah), cv2.CV_32F)
    dx = np.zeros(n); dy = np.zeros(n); ok = np.zeros(n, dtype=bool); nitidez = np.zeros(n)
    anterior = None
    for i in range(n):
        q = quadros[i].astype(np.float32)
        nitidez[i] = cv2.Laplacian(quadros[i], cv2.CV_32F).var()
        if anterior is not None:
            (sx, sy), resp = cv2.phaseCorrelate(anterior, q, janela)
            if resp > 0.05:  # só confia quando as duas imagens se parecem
                dx[i], dy[i], ok[i] = sx / aw, sy / aw, True  # em larguras do quadro
        anterior = q
    mov = np.hypot(dx, dy)
    achados = []  # (a, b, tipo) em quadros
    # chicote: deslocamento grande entre dois quadros seguidos
    lim_chicote = 0.05 * k
    for i in np.where(ok & (mov > lim_chicote))[0]:
        achados.append((i - 3, i + 6, "chicote"))
    # tremida: em 1 s, o quadro muda de direção várias vezes com movimento pequeno mas constante
    w = fps
    lim_tremer = 0.006 * k
    for i in range(0, n - w):
        seg_x, seg_y, seg_ok = dx[i:i + w], dy[i:i + w], ok[i:i + w]
        if seg_ok.sum() < w * 0.7:
            continue
        def inversoes(v):
            v = v[np.abs(v) > 0.0015]
            return int((np.sign(v[1:]) != np.sign(v[:-1])).sum()) if len(v) > 1 else 0
        if max(inversoes(seg_x), inversoes(seg_y)) >= 4 and np.mean(mov[i:i + w][seg_ok]) > lim_tremer:
            achados.append((i, i + w, "tremida"))
    # desfoque: nitidez cai muito abaixo do normal da câmera (mediana das últimas ~5 s)
    ref = np.array([np.median(nitidez[max(0, i - 5 * fps): i + 1]) for i in range(n)])
    ruim = nitidez < ref * (0.35 / k)
    i = 0
    while i < n:
        if ruim[i]:
            j = i
            while j < n and ruim[j]:
                j += 1
            if j - i >= 3:
                achados.append((i, j, "desfoque"))
            i = j
        else:
            i += 1
    # junta e converte para segundos
    achados.sort()
    saida = []
    for a, b, tipo in achados:
        a, b = max(0, a) / fps + ini, min(n, b) / fps + ini
        if saida and a <= saida[-1]["b"] + 0.2:
            saida[-1]["b"] = max(saida[-1]["b"], b)
            if tipo not in saida[-1]["tipo"]:
                saida[-1]["tipo"] += "+" + tipo
        else:
            saida.append({"a": float(round(a, 2)), "b": float(round(b, 2)), "tipo": tipo})
    return saida


def trocar_por_defeitos(trechos, defeitos, cameras_ordem, geral):
    """trechos: [{ini,fim,quem,camera}] em tempo do gravador. defeitos: {camera: [(a,b)]} no mesmo
    tempo. Onde a câmera escolhida está ruim, usa outra boa (a geral primeiro). Devolve (trechos, trocas)."""
    def ruim(cam, a, b):
        return any(x < b and y > a for x, y in defeitos.get(cam, []))

    saida, trocas = [], []
    for tr in trechos:
        cam = tr["camera"] or geral
        pontos = {tr["ini"], tr["fim"]}
        for x, y in defeitos.get(cam, []):
            for v in (x, y):
                if tr["ini"] < v < tr["fim"]:
                    pontos.add(v)
        pontos = sorted(pontos)
        for a, b in zip(pontos, pontos[1:]):
            nova = cam
            if ruim(cam, a, b):
                alternativas = [geral] + [c for c in cameras_ordem if c not in (geral, cam)]
                for alt in alternativas:
                    if alt != cam and not ruim(alt, a, b):
                        nova = alt
                        break
            novo = dict(tr)
            novo["ini"], novo["fim"], novo["camera"] = a, b, nova
            if nova != cam:
                trocas.append({"a": round(a, 2), "b": round(b, 2), "de": cam, "para": nova})
            saida.append(novo)
    return saida, trocas


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
                  cortar_silencios=False, faixas=None, apresentador=None, prioridade=0,
                  trechos_prontos=None, recorte=None, corrigir_camera=None):
    """Junta tudo: sincronia das câmeras, quem fala, silêncios a cortar.
    cameras: {"V1": caminho, ...}. Devolve o plano de montagem."""
    total = duracao_total(wav)
    grossos = deslocamentos(wav, [cameras[k] for k in cameras])
    atraso = {}
    for (nome, caminho), (g, conf) in zip(cameras.items(), grossos):
        fino, medidas = sincronia_fina(wav, caminho, g)
        atraso[nome] = {"valor": fino, "medidas": medidas, "confianca": conf}

    if trechos_prontos:  # trilha única: quem fala já foi descoberto pela voz
        import numpy as np
        janela = 0.1
        trechos = [dict(t) for t in trechos_prontos]
        tempo = {}
        for t in trechos:
            tempo[t["quem"]] = tempo.get(t["quem"], 0.0) + (t["fim"] - t["ini"])
        alguem = np.ones(int(total / janela) + 1, dtype=bool)
    else:
        trechos, tempo, alguem, janela = quem_fala(pessoas, wav, duracao_minima=duracao_minima, recorte=recorte)
    trechos = priorizar_apresentador(trechos, pessoas, apresentador, int(prioridade or 0))

    trocas_defeito, defeitos_achados = [], {}
    if corrigir_camera:
        rec_d = _recorte_ok(recorte, total)
        for cam, info in atraso.items():
            d = info["valor"]  # a câmera está 'd' segundos adiante do gravador
            a0 = (rec_d[0] if rec_d else 0.0) + d
            b0 = (rec_d[1] if rec_d else total) + d
            achados = defeitos_camera(cameras[cam], max(0.0, a0), b0, corrigir_camera)
            # em tempo do gravador, com folga para a troca não virar uma "piscada" de menos de 0,6 s
            lista = []
            for x in achados:
                a, b = x["a"] - d - 0.15, x["b"] - d + 0.15
                if b - a < 0.6:
                    c = (a + b) / 2
                    a, b = c - 0.3, c + 0.3
                lista.append((a, b, x["tipo"]))
            defeitos_achados[cam] = lista
        trechos, trocas_defeito = trocar_por_defeitos(
            trechos, {c: [(a, b) for a, b, _ in v] for c, v in defeitos_achados.items()}, list(cameras.keys()), geral)

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
    rec = _recorte_ok(recorte, total)
    if rec:  # a sequência só usa um pedaço do material: monta só esse pedaço
        inicio_ok, fim_ok = max(inicio_ok, rec[0]), min(fim_ok, rec[1])
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
            "tempo": tempo, "keeps": keeps, "pecas": pecas,
            "defeitos": {c: [{"a": round(a, 2), "b": round(b, 2), "tipo": t} for a, b, t in v] for c, v in defeitos_achados.items()},
            "trocasPorDefeito": trocas_defeito}



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


def transcricao_completa(palavras, wav):
    """True se a transcrição guardada cobre o podcast (e não só um trechinho feito antes pelas legendas In/Out)."""
    try:
        if not palavras or len(palavras) < 30:
            return False
        return (palavras[-1]["e"] - palavras[0]["s"]) >= 0.5 * duracao_total(wav)
    except Exception:
        return False


def legendas_podcast(wav, pessoas, modelo, dispositivo, idioma, reutilizar):
    base = os.path.splitext(wav)[0]
    cache = base + "_palavras.json"
    palavras = None
    if reutilizar and os.path.isfile(cache):
        with open(cache, encoding="utf-8") as f:
            palavras = json.load(f)
        if not transcricao_completa(palavras, wav):
            palavras = None  # só tinha um trecho: transcreve o podcast inteiro
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


# ---------------------------------------------------------------------------
# Modelos de legenda guardados num projeto do Premiere (.prproj)
# O servidor troca o texto e a posição das camadas dentro de uma cópia do projeto;
# o painel importa essa cópia e coloca a sequência na timeline.
# ---------------------------------------------------------------------------
MODELOS_PROJETO = {
    "Criativo 1": {
        "base": "base_modelos.prproj",
        "guid": "4446a599-d4e4-4334-93de-6a82fcaab2ac",
        "nome_seq": "MODELO_1",
        "exemplo": ["stories com", "LEGENDAS", "tutorial//como ativar?"],
        "camadas": [30, 31, 32],
        "layout": [
            {"linha": 0, "pos": (0.5, 0.30), "esc": 55},
            {"linha": 2, "pos": (0.5, 0.72), "esc": 70},
            {"linha": 1, "pos": (0.5, 0.50), "esc": 150},
        ],
    },
    "Criativo 2": {
        "base": "base_modelos.prproj",
        "guid": "e1b6e694-43e2-4d4e-863b-e5e56187eda6",
        "nome_seq": "MODELO_2",
        "exemplo": ["LEGENDAS", "criativas e", "ANIMADAS"],
        "camadas": [18, 19, 20],
        "layout": [
            {"pos": (0.5, 0.32)},
            {"pos": (0.5, 0.50), "rot": -6},
            {"pos": (0.5, 0.68)},
        ],
    },
    "Criativo 3": {
        "base": "base_modelos.prproj",
        "guid": "1a1503bd-4a30-476c-8090-dc911e510ca3",
        "nome_seq": "MODELO_3",
        "exemplo": ["ONDE NÃO", "colocar"],
        "camadas": [27, 28, 29],
        "layout": [
            {"linha": 0, "pos": (0.5, 0.40), "esc": 140},
            {"linha": 1, "pos": (0.5, 0.62), "esc": 130, "rot": -4},
            {"linha": 2, "pos": (0.5, 0.90)},
        ],
    },
    "Criativo 4": {
        "base": "base_modelos.prproj",
        "guid": "f882ad1f-cfaa-46a0-8d28-46d807284214",
        "nome_seq": "MODELO_4",
        "exemplo": ["Por que", "legendar", "vídeos", "para redes sociais?"],
        "camadas": [33, 34, 35, 36],
        "layout": [
            {"pos": (0.5, 0.30), "esc": 70},
            {"pos": (0.5, 0.45), "esc": 110},
            {"pos": (0.5, 0.62), "esc": 110},
            {"pos": (0.5, 0.78), "esc": 50},
        ],
    },
}
_BL = re.compile(r'(<StartKeyframeValue Encoding="base64" BinaryHash="[^"]*">)(\s*)([A-Za-z0-9+/=\s]+?)(\s*</StartKeyframeValue>)')
_REF = re.compile(r'<StartKeyframeValue Encoding="base64" BinaryHash="([^"]*)"/>')


def _fb_trocar_texto(b, antigo, novo):
    """Troca um texto dentro do bloco binário (FlatBuffers) de um texto do Premiere."""
    import struct
    ant = antigo.encode("utf-8")
    nov = novo.encode("utf-8")
    corpo = bytearray(b[8:])
    pos = bytes(corpo).find(struct.pack("<I", len(ant)) + ant + b"\0")
    if pos < 0:
        raise ValueError("texto de exemplo não encontrado no modelo")
    refs = [p for p in range(0, len(corpo) - 3, 4)
            if p != pos and p + struct.unpack_from("<I", corpo, p)[0] == pos]
    if not refs:
        raise ValueError("ponteiro do texto não encontrado")
    while len(corpo) % 4:
        corpo.append(0)
    novo_pos = len(corpo)
    corpo += struct.pack("<I", len(nov)) + nov + b"\0"
    while len(corpo) % 4:
        corpo.append(0)
    for p in refs:
        struct.pack_into("<I", corpo, p, novo_pos - p)
    cab = bytearray(b[:8])
    struct.pack_into("<I", cab, 0, len(corpo) - 4)
    return bytes(cab) + bytes(corpo)


def _prproj_camadas(x):
    saida = []
    for m in re.finditer(r"<InstanceName>Nova camada de texto</InstanceName>", x):
        j = x.rfind("<Component ", 0, m.start())
        saida.append(dict(re.findall(r'<Param Index="(\d+)" ObjectRef="(\d+)"/>', x[j:m.start()])))
    return saida


def _prproj_valor(x, oid, valor):
    k = x.find('ObjectID="%s"' % oid)
    a = x.find("<StartKeyframe>", k)
    b = x.find("</StartKeyframe>", a)
    return x[:a] + "<StartKeyframe>" + valor + x[b:]


def _prproj_materializar(x, k):
    a = x.find("<StartKeyframeValue", k)
    m = _REF.match(x, a)
    if not m:
        return x
    h = m.group(1)
    origem = re.search(r'<StartKeyframeValue Encoding="base64" BinaryHash="%s">([^<]*)</StartKeyframeValue>' % re.escape(h), x)
    novo_h = h[:-4] + "%04x" % (abs(hash((k, h))) % 65536)
    return x[:a] + '<StartKeyframeValue Encoding="base64" BinaryHash="%s">%s</StartKeyframeValue>' % (novo_h, origem.group(1)) + x[m.end():]


def preparar_modelo_projeto(nome, linhas):
    """Cria uma cópia do projeto-base com os textos das 'linhas' e devolve caminho + GUID da sequência."""
    import base64
    import gzip
    import hashlib
    cfg = MODELOS_PROJETO.get(nome)
    if not cfg:
        raise RuntimeError("Modelo desconhecido: " + str(nome))
    base = os.path.join(_RAIZ, "modelos", cfg["base"])
    if not os.path.isfile(base):
        raise RuntimeError("Não achei o projeto-base dos modelos: " + base)
    with gzip.open(base, "rb") as g:
        x = g.read().decode("utf-8", errors="replace")
    todas = _prproj_camadas(x)
    linhas = list(linhas) + [""] * (len(cfg["camadas"]) + 2)
    for idx in cfg["camadas"]:  # 1ª passada: camadas que só apontam para outra ganham cópia própria
        x = _prproj_materializar(x, x.find('ObjectID="%s"' % todas[idx]["0"]))
    for i, idx in enumerate(cfg["camadas"]):
        c = todas[idx]
        k = x.find('ObjectID="%s"' % c["0"])
        m = _BL.search(x, k)
        b = base64.b64decode(re.sub(r"\s", "", m.group(3)))
        lay = cfg["layout"][i]
        n = _fb_trocar_texto(b, "Nova camada de texto", linhas[lay.get("linha", i)])
        x = x[:m.start(3)] + base64.b64encode(n).decode() + x[m.end(3):]
        if "pos" in lay:
            x = _prproj_valor(x, c["2"], "-91445760000000000,%s:%s,0,0,0,0,0,0,5,4,0,0,0,0" % lay["pos"])
        if "esc" in lay:
            x = _prproj_valor(x, c["3"], "-91445760000000000,%s.,0,0,0,0,0,0" % lay["esc"])
        if "rot" in lay:
            x = _prproj_valor(x, c["6"], "-91445760000000000,%s.,0,0,0,0,0,0" % lay["rot"])
    pasta = os.path.join(_RAIZ, "modelos", "gerados")
    os.makedirs(pasta, exist_ok=True)
    chave = hashlib.md5(("|".join([nome] + [str(l) for l in linhas])).encode("utf-8")).hexdigest()[:10]
    destino = os.path.join(pasta, "%s_%s.prproj" % (nome.replace(" ", "_"), chave))
    with gzip.open(destino, "wb") as g:
        g.write(x.encode("utf-8"))
    return {"caminho": destino, "guid": cfg["guid"], "nome": cfg["nome_seq"]}



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



# ----------------------------------------------- legendas "overlay" (um vídeo transparente só)
# Estilo dos 4 modelos Criativo, desenhados direto pelo programa local (sem importar sequências).
# fonte: nome do arquivo; tam: altura da letra em fração da altura do quadro; y: posição vertical
ESTILOS_OVERLAY = {
    "Criativo 1": [
        {"f": "Anton-Regular", "tam": 0.050, "y": 0.34, "cor": (176, 156, 255), "caixa": False},
        {"f": "Anton-Regular", "tam": 0.150, "y": 0.50, "cor": (176, 156, 255), "caixa": True},
        {"f": "Caveat Brush-Regular", "tam": 0.075, "y": 0.66, "cor": (176, 156, 255), "caixa": False},
    ],
    "Criativo 2": [
        {"f": "Anton-Regular", "tam": 0.090, "y": 0.40, "cor": (255, 255, 255), "caixa": True},
        {"f": "Caveat Brush-Regular", "tam": 0.100, "y": 0.52, "cor": (255, 205, 0), "caixa": False, "rot": 6},
        {"f": "Anton-Regular", "tam": 0.090, "y": 0.64, "cor": (255, 255, 255), "caixa": True},
    ],
    "Criativo 3": [
        {"f": "Anton-Regular", "tam": 0.140, "y": 0.44, "cor": (255, 215, 0), "caixa": True},
        {"f": "Caveat Brush-Regular", "tam": 0.100, "y": 0.62, "cor": (255, 255, 255), "caixa": False, "rot": 4},
    ],
    "Criativo 4": [
        {"f": "Poppins-Regular", "tam": 0.050, "y": 0.33, "cor": (255, 255, 255), "caixa": False},
        {"f": "Poppins-Bold", "tam": 0.090, "y": 0.45, "cor": (255, 255, 255), "caixa": False},
        {"f": "Poppins-Bold", "tam": 0.090, "y": 0.57, "cor": (255, 40, 200), "caixa": False},
        {"f": "Poppins-Regular", "tam": 0.042, "y": 0.68, "cor": (255, 255, 255), "caixa": False},
    ],
}


def _achar_fonte(nome, tamanho):
    from PIL import ImageFont
    pastas = [os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "Windows", "Fonts"),
              os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "Fonts")]
    for p in pastas:
        for ext in (".ttf", ".otf"):
            c = os.path.join(p, nome + ext)
            if os.path.isfile(c):
                return ImageFont.truetype(c, tamanho)
    for reserva in ("segoeuib.ttf", "arialbd.ttf", "arial.ttf"):
        for p in pastas:
            c = os.path.join(p, reserva)
            if os.path.isfile(c):
                return ImageFont.truetype(c, tamanho)
    try:
        return ImageFont.load_default(tamanho)
    except TypeError:
        return ImageFont.load_default()


# ---------------------------------------------------------------- estilos (embutidos e do usuário)

ANIM_PADRAO = {"entrada": "pop", "duracao": 0.28, "atraso": 0.07, "saida": "fade", "pilha": "normal"}
ENTRADAS = ("pop", "fade", "subir", "descer", "zoom", "quicar", "digitar", "nenhuma")


def _pasta_estilos():
    return os.path.join(_RAIZ, "estilos")


def _nome_seguro(nome):
    import unicodedata
    n = unicodedata.normalize("NFKD", str(nome)).encode("ascii", "ignore").decode("ascii")
    n = re.sub(r"[^A-Za-z0-9 _-]", "", n).strip()
    return re.sub(r"\s+", " ", n)[:40]


def _limpar_def(d):
    """Garante uma definição de estilo válida (limites e valores padrão)."""
    def num(v, lo, hi, pad):
        try:
            return max(lo, min(hi, float(v)))
        except Exception:
            return pad

    def cor(v, pad=(255, 255, 255)):
        try:
            return tuple(int(max(0, min(255, c))) for c in v[:3])
        except Exception:
            return pad

    linhas = []
    for l in (d.get("linhas") or [])[:6]:
        n = {"f": str(l.get("f", "Poppins-Bold")), "tam": num(l.get("tam"), 0.015, 0.30, 0.08),
             "y": num(l.get("y"), 0.02, 0.98, 0.5), "x": num(l.get("x"), 0.05, 0.95, 0.5),
             "cor": cor(l.get("cor")), "caixa": bool(l.get("caixa")), "rot": num(l.get("rot"), -45, 45, 0)}
        for k in ("contorno", "sombra", "tarja", "brilho"):
            if isinstance(l.get(k), dict):
                n[k] = l[k]
        if "sombra" in l and l["sombra"] is False:
            n["sombra"] = {"ligada": False}
        linhas.append(n)
    if not linhas:
        raise RuntimeError("O estilo precisa de pelo menos uma linha.")
    an = dict(ANIM_PADRAO)
    an.update({k: v for k, v in (d.get("anim") or {}).items() if k in ANIM_PADRAO})
    if an["entrada"] not in ENTRADAS:
        an["entrada"] = "pop"
    an["duracao"] = num(an["duracao"], 0.05, 1.5, 0.28)
    an["atraso"] = num(an["atraso"], 0.0, 0.5, 0.07)
    an["saida"] = "nenhuma" if an["saida"] == "nenhuma" else "fade"
    return {"linhas": linhas, "anim": an}


def estilos_usuario():
    saida = {}
    pasta = _pasta_estilos()
    if os.path.isdir(pasta):
        for nome in sorted(os.listdir(pasta)):
            if nome.lower().endswith(".json"):
                try:
                    with open(os.path.join(pasta, nome), encoding="utf-8") as f:
                        dados = json.load(f)
                    saida[dados["nome"]] = _limpar_def(dados["def"])
                except Exception:
                    pass
    return saida


def eh_estilo_overlay(nome):
    return nome in ESTILOS_OVERLAY or nome in estilos_usuario()


def _def_estilo(nome):
    if isinstance(nome, dict):
        return _limpar_def(nome)
    usuario = estilos_usuario()
    if nome in usuario:
        return usuario[nome]
    if nome in ESTILOS_OVERLAY:
        return _limpar_def({"linhas": ESTILOS_OVERLAY[nome]})
    raise RuntimeError("Estilo desconhecido: " + str(nome))


def _tempo_entrada(anim, n_linhas):
    if anim["entrada"] == "nenhuma":
        return 0.05
    return anim["duracao"] + anim["atraso"] * max(0, n_linhas - 1) + 0.05


def _sprites_legenda(estilo, texto, W, H):
    """Desenha cada linha da legenda numa imagem pequena transparente. Devolve [(imagem, cx, cy)]."""
    from PIL import Image, ImageDraw, ImageFilter
    camadas = _def_estilo(estilo)["linhas"]
    linhas = dividir_em_linhas(texto, len(camadas))
    linhas += [""] * (len(camadas) - len(linhas))
    saida = []
    for cam, txt in zip(camadas, linhas):
        if not txt:
            continue
        if cam.get("caixa"):
            txt = txt.upper()
        tam = max(10, int(H * cam["tam"]))
        cont = cam.get("contorno") if isinstance(cam.get("contorno"), dict) and cam["contorno"].get("ligada", True) else None
        brilho = cam.get("brilho") if isinstance(cam.get("brilho"), dict) and cam["brilho"].get("ligada", True) else None
        tarja = cam.get("tarja") if isinstance(cam.get("tarja"), dict) and cam["tarja"].get("ligada", True) else None
        sh = cam.get("sombra", {}) if isinstance(cam.get("sombra", {}), dict) else {}
        sombra_on = sh.get("ligada", True)

        def contorno_px(t):
            return max(1, int(t * float(cont.get("larg", 0.06)))) if cont else 0

        fonte = _achar_fonte(cam["f"], tam)
        while tam > 12 and fonte.getlength(txt) + 2 * contorno_px(tam) > W * 0.9:
            tam = int(tam * 0.92)
            fonte = _achar_fonte(cam["f"], tam)
        sw = contorno_px(tam)
        raio_b = max(2, int(tam * float(brilho.get("raio", 0.25)))) if brilho else 0
        m = int(tam * 0.5) + sw + raio_b * 3
        larg = int(fonte.getlength(txt)) + 2 * m
        alt = int(tam * 1.5) + 2 * m
        centro = (larg / 2, alt / 2)
        base = Image.new("RGBA", (larg, alt), (0, 0, 0, 0))
        d = ImageDraw.Draw(base)
        d.text(centro, txt, font=fonte, fill=tuple(cam["cor"]) + (255,), anchor="mm",
               stroke_width=sw, stroke_fill=tuple(cont.get("cor", (0, 0, 0)))[:3] + (255,) if cont else None)
        img = Image.new("RGBA", (larg, alt), (0, 0, 0, 0))
        if tarja:
            bx = d.textbbox(centro, txt, font=fonte, anchor="mm", stroke_width=sw)
            pad = int(tam * float(tarja.get("pad", 0.25)))
            raio = int(tam * float(tarja.get("raio", 0.25)))
            cor_t = tuple(int(c) for c in tarja.get("cor", (0, 0, 0)))[:3] + (int(255 * float(tarja.get("opac", 0.75))),)
            ImageDraw.Draw(img).rounded_rectangle((bx[0] - pad, bx[1] - pad * 0.6, bx[2] + pad, bx[3] + pad * 0.6),
                                                  radius=raio, fill=cor_t)
        if brilho:
            glow = Image.new("RGBA", (larg, alt), tuple(int(c) for c in brilho.get("cor", cam["cor"]))[:3] + (0,))
            a = base.getchannel("A").filter(ImageFilter.GaussianBlur(raio_b))
            k = float(brilho.get("forca", 0.8)) * 2.0
            glow.putalpha(a.point(lambda v, k=k: int(min(255, v * k))))
            img.alpha_composite(glow)
        if sombra_on:
            op = float(sh.get("opac", 0.65))
            sombra = Image.new("RGBA", (larg, alt), (0, 0, 0, 0))
            sombra.putalpha(base.getchannel("A").point(lambda v, op=op: int(v * op)))
            cor_s = tuple(int(c) for c in sh.get("cor", (0, 0, 0)))[:3]
            sombra = Image.merge("RGBA", tuple(Image.new("L", (larg, alt), c) for c in cor_s) + (sombra.getchannel("A"),))
            sombra = sombra.filter(ImageFilter.GaussianBlur(max(1, int(tam * float(sh.get("blur", 1 / 18.0))))))
            desl = max(1, int(tam * float(sh.get("dist", 1 / 16.0))))
            img.alpha_composite(sombra, (desl // 2, desl))
        img.alpha_composite(base)
        if cam.get("rot"):
            img = img.rotate(cam["rot"], resample=Image.BICUBIC, expand=True)
        saida.append((img, W * cam.get("x", 0.5), H * cam["y"]))
    return saida


def _quadro_legenda(sprites, W, H, t, dur, anim=None):
    """Monta o quadro da legenda no tempo t (segundos desde o início dela), com a animação do estilo."""
    from PIL import Image
    an = anim or ANIM_PADRAO
    ent, d_ent, atraso = an["entrada"], an["duracao"], an["atraso"]
    quadro = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    pecas = []  # (ordem, imagem, x, y)
    for i, (img, cx, cy) in enumerate(sprites):
        te = t - i * atraso
        saida_t = dur - t
        if te <= 0 and ent != "nenhuma":
            continue
        esc, alfa, dy, corte = 1.0, 1.0, 0.0, 1.0
        k = min(1.0, max(0.0, te / d_ent))
        suave = 1 - (1 - k) ** 3
        if te < d_ent and ent != "nenhuma":
            if ent == "pop":
                esc = 0.75 + 0.25 * k + 0.07 * math.sin(k * math.pi)
                alfa = min(1.0, te / (d_ent / 2))
            elif ent == "fade":
                alfa = suave
            elif ent == "subir":
                dy, alfa = (1 - suave) * 0.06 * H, suave
            elif ent == "descer":
                dy, alfa = -(1 - suave) * 0.06 * H, suave
            elif ent == "zoom":
                esc, alfa = 1.35 - 0.35 * suave, suave
            elif ent == "quicar":
                esc = max(0.05, 1 - math.exp(-5 * k) * math.cos(k * 3 * math.pi))
                alfa = min(1.0, te / 0.1)
            elif ent == "digitar":
                corte = k
        if an["saida"] == "fade" and saida_t < 0.18:
            ks = max(0.0, saida_t / 0.18)
            alfa = min(alfa, ks)
            esc *= 0.96 + 0.04 * ks
        if alfa <= 0.01:
            continue
        s = img
        x0 = cx - img.width / 2
        if corte < 0.999:
            s = img.crop((0, 0, max(1, int(img.width * corte)), img.height))
        if abs(esc - 1.0) > 0.003:
            s = s.resize((max(1, int(s.width * esc)), max(1, int(s.height * esc))), Image.BILINEAR)
        if alfa < 0.999:
            s = s.copy()
            s.putalpha(s.getchannel("A").point(lambda v, a=alfa: int(v * a)))
        px = int(x0) if corte < 0.999 else int(cx - s.width / 2)
        py = int(cy + dy - s.height / 2)
        pecas.append((i, s, px, py))
    pil = an.get("pilha")
    if isinstance(pil, list) and len(pil) == len(sprites):  # profundidade: 0 = na frente de todas
        pecas.sort(key=lambda p: -pil[p[0]])
    elif pil == "topo":
        pecas.reverse()
    for _i, s, px, py in pecas:
        if px < 0 or py < 0 or px + s.width > W or py + s.height > H:  # recorta o que passa da tela
            tela = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            tela.paste(s, (px, py))
            quadro.alpha_composite(tela)
        else:
            quadro.alpha_composite(s, (px, py))
    return quadro


# ----------------------------------------------- Criativos: imagem em tela cheia + frases animadas
ENTRADAS_IMAGEM = ("nenhuma", "fade", "zoom", "subir", "descer", "esquerda", "direita", "revelar")
_CACHE_FUNDO = {}


def _def_criativo(d):
    """Normaliza a definição enviada pelo painel. Devolve (fundo, textos, anim, extra)."""
    def num(v, lo, hi, pad):
        try:
            return max(lo, min(hi, float(v)))
        except Exception:
            return pad
    f = d.get("fundo") or {}
    fundo = {
        "imagem": str(d.get("imagem") or ""),
        "cor": tuple(int(max(0, min(255, c))) for c in (f.get("cor") or (12, 12, 22))[:3]),
        "escurecer": num(f.get("escurecer"), 0.0, 0.95, 0.4),
        "desfoque": num(f.get("desfoque"), 0.0, 40.0, 0.0),
        "zoomLento": bool(f.get("zoomLento", True)),
        "entrada": f.get("entrada") if f.get("entrada") in ENTRADAS_IMAGEM else "fade",
        "duracao": num(f.get("duracao"), 0.05, 2.5, 0.6),
        "saida": bool(f.get("saida", True)),
    }
    textos = [t for t in (d.get("textos") or [])[:4] if isinstance(t, dict)]
    camadas = _limpar_def({"linhas": [t.get("linha") or {} for t in textos], "anim": d.get("anim") or {}})
    normais = []
    for t, cam in zip(textos, camadas["linhas"]):
        normais.append({"texto": str(t.get("texto") or ""), "larg": num(t.get("larg"), 0.3, 0.9, 0.8), "cam": cam})
    anim = dict(camadas["anim"])
    anim["inicio"] = num((d.get("anim") or {}).get("inicio"), 0.0, 3.0, 0.5)
    ar = d.get("area") or {}
    pg = d.get("paginas") or {}
    extra = {
        "area": {"x": num(ar.get("x"), 0.1, 0.9, 0.5), "y": num(ar.get("y"), 0.1, 0.9, 0.5),
                 "larg": num(ar.get("larg"), 0.3, 0.9, 0.8), "alt": num(ar.get("alt"), 0.1, 0.9, 0.5)},
        "pag": {"ativo": bool(pg.get("ativo")), "linhas": int(num(pg.get("linhas"), 1, 8, 3))},
        "tempos": [float(x) for x in (d.get("tempos") or []) if isinstance(x, (int, float))],
    }
    return fundo, normais, anim, extra


def _quebrar_texto(txt, fonte, largura):
    linhas = []
    for par in str(txt).replace("\r", "").split("\n"):
        atual = ""
        for pal in par.split():
            tentativa = (atual + " " + pal).strip()
            if atual and fonte.getlength(tentativa) > largura:
                linhas.append(atual)
                atual = pal
            else:
                atual = tentativa
        if atual:
            linhas.append(atual)
    return linhas


def _ajustar_linhas(txt, cam, W, H, larg_px, alt_px, n_ref=None):
    """Quebra o texto na largura da área e reduz a letra até caber na altura da área."""
    tam = max(10, int(H * cam["tam"]))
    while True:
        fonte = _achar_fonte(cam["f"], tam)
        linhas = _quebrar_texto(txt, fonte, larg_px)
        n = n_ref if n_ref else len(linhas)
        if tam <= 12 or n * tam * 1.16 <= alt_px:
            return linhas, tam / float(H)
        tam = int(tam * 0.93)


def _sprites_linhas(linhas, cam, tam_frac, cx, cy, W, H):
    sp = []
    n = len(linhas)
    passo = tam_frac * 1.16
    for k, ln in enumerate(linhas):
        c = dict(cam)
        c["tam"] = tam_frac
        c["x"] = cx
        c["y"] = cy + (k - (n - 1) / 2.0) * passo
        c["rot"] = 0
        c["caixa"] = False
        sp += _sprites_legenda({"linhas": [c]}, ln, W, H)
    return sp


def _tempos_das_palavras(palavras, orig, ini, fim):
    """Início de cada palavra do texto (em s desde o começo do criativo), mesmo que o texto tenha sido editado."""
    m = len(palavras)
    if not m:
        return []
    if orig:
        n = len(orig)
        saida = []
        for i in range(m):
            pos = i * n / float(m) if n != m else float(i)
            a = min(n - 1, int(pos))
            b = min(n - 1, a + 1)
            f = pos - a
            saida.append(orig[a] + (orig[b] - orig[a]) * f)
        return saida
    total = sum(len(p) + 1 for p in palavras)
    acum, saida = 0, []
    for p in palavras:
        saida.append(ini + (fim - ini) * acum / float(total))
        acum += len(p) + 1
    return saida


def _preparar_texto(normais, extra, anim, W, H, dur):
    """Devolve (paginas, referencias).
    paginas: [{t0, t1, sp, ref}] — a 1ª caixa (frase) usa a área; trechos separados por linha em branco viram blocos,
    cada bloco usa a referência de mesma ordem (a 2ª caixa tem uma referência por linha); dentro do bloco o texto
    pode entrar em partes de N linhas, no ritmo da fala. referencias: [{t0, t1, sp, r}]."""
    ar, pg = extra["area"], extra["pag"]
    paginas, refs_sp = [], []
    if not normais:
        return paginas, refs_sp
    # ---- referências (uma por linha da 2ª caixa)
    refs, cam_ref, larg_ref = [], None, 0.8
    if len(normais) > 1:
        cam_ref, larg_ref = dict(normais[1]["cam"]), normais[1]["larg"]
        refs = [ln.strip() for ln in normais[1]["texto"].splitlines() if ln.strip()]
        if cam_ref.get("caixa"):
            refs = [r.upper() for r in refs]
    # ---- frase
    cam = dict(normais[0]["cam"])
    txt = normais[0]["texto"].strip()
    if cam.get("caixa"):
        txt = txt.upper()
    if txt:
        blocos = [b.strip() for b in re.split(r"\n\s*\n", txt.replace("\r", "")) if b.strip()]
        larg_px, alt_px = int(W * min(0.9, ar["larg"]) * 0.96), int(H * ar["alt"])
        n_ref = pg["linhas"] if pg["ativo"] else None
        tf = min(_ajustar_linhas(b, cam, W, H, larg_px, alt_px, n_ref)[1] for b in blocos)
        fonte = _achar_fonte(cam["f"], max(10, int(H * tf)))
        cx, cy = ar["x"], ar["y"]
        palavras = txt.split()
        tempos = _tempos_das_palavras(palavras, extra["tempos"], anim["inicio"], max(anim["inicio"] + 1.0, dur - 0.5))
        idx, grupos = 0, []  # (bloco, linhas, índice da 1ª palavra)
        for bi, b in enumerate(blocos):
            linhas = _quebrar_texto(b.replace("\n", " "), fonte, larg_px)
            passo = pg["linhas"] if pg["ativo"] else max(1, len(linhas))
            palavras_bloco = 0
            for k in range(0, len(linhas), passo):
                g = linhas[k:k + passo]
                grupos.append((bi, g, idx + palavras_bloco))
                palavras_bloco += sum(len(l.split()) for l in g)
            idx += palavras_bloco
        if len(grupos) == 1:
            paginas.append({"t0": anim["inicio"], "t1": dur, "sp": _sprites_linhas(grupos[0][1], cam, tf, cx, cy, W, H), "ref": 0})
        else:
            marcas = [tempos[min(g[2], len(tempos) - 1)] if tempos else anim["inicio"] for g in grupos]
            for k, (bi, g, _i) in enumerate(grupos):
                t0 = max(anim["inicio"] if k == 0 else 0.0, marcas[k] - 0.12)
                t1 = max(t0 + 0.4, (marcas[k + 1] - 0.12) if k + 1 < len(grupos) else dur)
                paginas.append({"t0": t0, "t1": t1, "sp": _sprites_linhas(g, cam, tf, cx, cy, W, H), "ref": bi})
    # ---- referências: cada uma aparece enquanto o(s) bloco(s) dela estiver(em) na tela
    if refs:
        for r, texto_r in enumerate(refs):
            if paginas:
                meus = [p for p in paginas if min(p["ref"], len(refs) - 1) == r]
                if not meus:
                    continue
                t0 = min(p["t0"] for p in meus)
                t1 = dur if r == len(refs) - 1 else max(p["t1"] for p in meus)
            else:
                t0, t1 = anim["inicio"], dur
            tam = max(10, int(H * cam_ref["tam"]))
            ln = _quebrar_texto(texto_r, _achar_fonte(cam_ref["f"], tam), int(W * min(0.88, larg_ref)))
            refs_sp.append({"t0": t0, "t1": t1, "r": r, "sp": _sprites_linhas(ln, cam_ref, cam_ref["tam"], cam_ref.get("x", 0.5), cam_ref["y"], W, H)})
    return paginas, refs_sp


def _fundo_base(fundo, W, H):
    from PIL import Image, ImageFilter
    chave = (fundo["imagem"], os.path.getmtime(fundo["imagem"]) if os.path.isfile(fundo["imagem"]) else 0,
             W, H, fundo["escurecer"], fundo["desfoque"], fundo["cor"])
    if chave in _CACHE_FUNDO:
        return _CACHE_FUNDO[chave]
    if fundo["imagem"] and os.path.isfile(fundo["imagem"]):
        im = Image.open(fundo["imagem"]).convert("RGB")
        k = max(W / im.width, H / im.height)
        im = im.resize((max(W, int(im.width * k + 0.5)), max(H, int(im.height * k + 0.5))), Image.LANCZOS)
        x0, y0 = (im.width - W) // 2, (im.height - H) // 2
        im = im.crop((x0, y0, x0 + W, y0 + H))
    else:
        im = Image.new("RGB", (W, H), fundo["cor"])
    if fundo["desfoque"] > 0:
        im = im.filter(ImageFilter.GaussianBlur(fundo["desfoque"] * H / 1080.0))
    if fundo["escurecer"] > 0:
        im = Image.blend(im, Image.new("RGB", (W, H), (0, 0, 0)), fundo["escurecer"])
    if len(_CACHE_FUNDO) > 6:
        _CACHE_FUNDO.clear()
    _CACHE_FUNDO[chave] = im.convert("RGBA")
    return _CACHE_FUNDO[chave]


def _quadro_fundo(base, W, H, t, dur, f):
    from PIL import Image
    ent, d_ent = f["entrada"], f["duracao"]
    k = 1.0 if ent == "nenhuma" else min(1.0, max(0.0, t / d_ent))
    suave = 1 - (1 - k) ** 3
    esc, alfa, dx, dy, rev = 1.0, 1.0, 0, 0, 1.0
    if f["zoomLento"]:
        esc *= 1.0 + 0.08 * min(1.0, t / max(dur, 0.1))
    if ent == "fade":
        alfa = suave
    elif ent == "zoom":
        esc *= 1.3 - 0.3 * suave
        alfa = min(1.0, suave * 1.5)
    elif ent == "subir":
        dy = int((1 - suave) * H)
    elif ent == "descer":
        dy = -int((1 - suave) * H)
    elif ent == "esquerda":
        dx = -int((1 - suave) * W)
    elif ent == "direita":
        dx = int((1 - suave) * W)
    elif ent == "revelar":
        rev = suave
    if f["saida"] and dur - t < 0.3:
        alfa = min(alfa, max(0.0, (dur - t) / 0.3))
    if esc > 1.001:
        w2, h2 = W / esc, H / esc
        img = base.resize((W, H), Image.BILINEAR, box=((W - w2) / 2, (H - h2) / 2, (W + w2) / 2, (H + h2) / 2))
    else:
        img = base
    if rev < 0.999:
        cw = max(1, int(W * rev))
        tela = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        tela.paste(img.crop((0, 0, cw, H)), (0, 0))
        img = tela
    elif dx or dy:
        tela = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        tela.paste(img, (dx, dy))
        img = tela
    if alfa < 0.999:
        img = img.copy()
        img.putalpha(img.getchannel("A").point(lambda v, a=alfa: int(v * a)))
    return img


def _quadro_criativo(base, paginas, refs, anim, fundo, W, H, t, dur):
    quadro = _quadro_fundo(base, W, H, t, dur, fundo).copy()
    for rf in refs:
        if rf["t0"] - 1e-6 <= t < rf["t1"]:
            quadro.alpha_composite(_quadro_legenda(rf["sp"], W, H, t - rf["t0"], rf["t1"] - rf["t0"], anim))
            break
    for pgn in paginas:
        if pgn["t0"] - 1e-6 <= t < pgn["t1"]:
            quadro.alpha_composite(_quadro_legenda(pgn["sp"], W, H, t - pgn["t0"], pgn["t1"] - pgn["t0"], anim))
            break
    return quadro


def criativo_previa(d, saida_png, vertical=False):
    from PIL import Image, ImageDraw
    W, H = (540, 960) if vertical else (960, 540)
    fundo, normais, anim, extra = _def_criativo(d)
    base = _fundo_base(fundo, W, H)
    paginas, fixos = _preparar_texto(normais, extra, anim, W, H, 60.0)
    quadro = _quadro_fundo(base, W, H, 99.0, 1e6, fundo).copy()
    r0 = paginas[0]["ref"] if paginas else 0
    mostrar = [f for f in fixos if f["r"] == min(r0, len(fixos) - 1)] or fixos[:1]
    for f in mostrar:
        quadro.alpha_composite(_quadro_legenda(f["sp"], W, H, 99.0, 1e6, anim))
    if paginas:
        quadro.alpha_composite(_quadro_legenda(paginas[0]["sp"], W, H, 99.0, 1e6, anim))
    fundo_ = Image.new("RGBA", (W, H), (36, 36, 52, 255))
    fundo_.alpha_composite(quadro)
    if d.get("guias"):
        g = fundo_.copy()
        dg = ImageDraw.Draw(g)
        dg.rectangle((0, 0, W - 1, H - 1), outline=(255, 255, 255, 255), width=2)
        mx, my = int(W * 0.05), int(H * 0.05)
        dg.rectangle((mx, my, W - mx, H - my), outline=(255, 214, 0, 255), width=2)
        dg.line((W // 2, 0, W // 2, H), fill=(0, 220, 255, 255), width=2)
        dg.line((0, H // 2, W, H // 2), fill=(0, 220, 255, 255), width=2)
        ar = extra["area"]  # área do texto
        dg.rectangle((W * (ar["x"] - ar["larg"] / 2), H * (ar["y"] - ar["alt"] / 2), W * (ar["x"] + ar["larg"] / 2), H * (ar["y"] + ar["alt"] / 2)),
                     outline=(80, 255, 140, 255), width=3)
        fundo_ = g
    os.makedirs(os.path.dirname(saida_png), exist_ok=True)
    fundo_.convert("RGB").save(saida_png)


def criativo_gerar(d, W, H, fps, dur, saida):
    """Desenha o criativo (imagem + frases + animações) num .mov com transparência."""
    W, H = int(W) // 2 * 2, int(H) // 2 * 2
    fps = float(fps)
    dur = max(0.5, float(dur))
    fundo, normais, anim, extra = _def_criativo(d)
    base = _fundo_base(fundo, W, H)
    paginas, fixos = _preparar_texto(normais, extra, anim, W, H, dur)
    n = max(2, int(round(dur * fps)))
    os.makedirs(os.path.dirname(saida), exist_ok=True)
    p = subprocess.Popen(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba",
                          "-s", "%dx%d" % (W, H), "-r", str(fps), "-i", "-", "-c:v", "qtrle", "-pix_fmt", "argb", saida],
                         stdin=subprocess.PIPE)
    for k in range(n):
        p.stdin.write(_quadro_criativo(base, paginas, fixos, anim, fundo, W, H, k / fps, dur).tobytes())
    p.stdin.close()
    if p.wait() != 0:
        raise RuntimeError("O ffmpeg falhou ao desenhar o criativo.")
    return {"arquivo": saida, "quadros": n}


def texto_do_trecho(caminho, inicio, fim, modelo, dispositivo, idioma):
    cache, n, _ = palavras_do_trecho(caminho, inicio, fim, modelo, dispositivo, idioma)
    with open(cache, encoding="utf-8") as f:
        palavras = json.load(f)
    uteis = [p for p in palavras if p["s"] >= inicio - 0.3 and p["e"] <= fim + 0.3]
    return {"texto": " ".join(p["w"] for p in uteis).strip(), "palavras": [{"w": p["w"], "s": p["s"], "e": p["e"]} for p in uteis]}


def _png_conta_gotas(tam=32):
    """Ícone de conta-gotas (branco com contorno escuro), ponta no canto inferior esquerdo."""
    from PIL import Image, ImageDraw
    import io
    k = 8
    S = tam * k
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    u = S / 32.0
    def forma(cor, extra):
        e = extra * u
        d.line([(22 * u, 10 * u), (9 * u, 23 * u)], fill=cor, width=int(6 * u + 2 * e))
        d.line([(9 * u, 23 * u), (3.5 * u, 28.5 * u)], fill=cor, width=int(2.4 * u + 2 * e))
        d.ellipse((20 * u - e, 2 * u - e, 30 * u + e, 12 * u + e), fill=cor)
        d.line([(19 * u, 8 * u), (24 * u, 13 * u)], fill=cor, width=int(3 * u + 2 * e))
    forma((20, 20, 30, 255), 1.3)
    forma((255, 255, 255, 255), 0)
    im = im.resize((tam, tam), Image.LANCZOS)
    b = io.BytesIO()
    im.save(b, "PNG")
    return b.getvalue()


_CURSOR_TROCADO = {"ativo": False, "ultimo": 0.0}


def _cursor_conta_gotas(ligar):
    """Troca (ou restaura) o cursor do mouse no Windows inteiro pelo conta-gotas."""
    if os.name != "nt":
        return
    import ctypes
    import struct
    import tempfile
    import time
    u = ctypes.windll.user32
    if not ligar:
        u.SystemParametersInfoW(0x57, 0, None, 0)  # SPI_SETCURSORS: volta ao padrão
        _CURSOR_TROCADO["ativo"] = False
        return
    _CURSOR_TROCADO["ultimo"] = time.time()
    if _CURSOR_TROCADO["ativo"]:
        return
    png = _png_conta_gotas(32)
    cur = struct.pack("<HHH", 0, 2, 1) + struct.pack("<BBBBHHII", 32, 32, 0, 0, 3, 28, len(png), 22) + png
    caminho = os.path.join(tempfile.gettempdir(), "podcast_pro_conta_gotas.cur")
    open(caminho, "wb").write(cur)
    u.LoadImageW.restype = ctypes.c_void_p
    u.SetSystemCursor.argtypes = [ctypes.c_void_p, ctypes.c_uint]
    for ocr in (32512, 32513, 32649, 32515, 32514):  # seta, texto, mão, cruz, espera
        h = u.LoadImageW(None, caminho, 2, 32, 32, 0x10)
        if h:
            u.SetSystemCursor(h, ocr)
    _CURSOR_TROCADO["ativo"] = True

    def vigia():  # se o painel parar de perguntar (fechou, travou), devolve o cursor normal
        while _CURSOR_TROCADO["ativo"]:
            time.sleep(1.0)
            if time.time() - _CURSOR_TROCADO["ultimo"] > 3.0:
                _cursor_conta_gotas(False)
    threading.Thread(target=vigia, daemon=True).start()


def cor_da_tela():
    """Conta-gotas: cor do pixel sob o mouse (qualquer janela, no Windows) e se o botão esquerdo/Esc estão apertados."""
    if os.name != "nt":
        raise RuntimeError("O conta-gotas só funciona no Windows.")
    import ctypes
    from ctypes import wintypes
    u, g = ctypes.windll.user32, ctypes.windll.gdi32
    try:
        u.SetProcessDPIAware()
    except Exception:
        pass
    u.GetDC.restype = wintypes.HDC
    u.GetDC.argtypes = [wintypes.HWND]
    u.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
    g.GetPixel.restype = wintypes.DWORD
    g.GetPixel.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int]
    pt = wintypes.POINT()
    u.GetCursorPos(ctypes.byref(pt))
    hdc = u.GetDC(None)
    c = g.GetPixel(hdc, pt.x, pt.y)
    u.ReleaseDC(None, hdc)
    if c == 0xFFFFFFFF:
        c = 0
    cor = "#%02X%02X%02X" % (c & 255, (c >> 8) & 255, (c >> 16) & 255)
    import time
    _CURSOR_TROCADO["ultimo"] = time.time()
    return {"cor": cor, "clicando": bool(u.GetAsyncKeyState(1) & 0x8000), "esc": bool(u.GetAsyncKeyState(0x1B) & 0x8000)}


def renderizar_previa(defn, texto, saida_png, W=1280, H=720, recorte=(640, 300), guias=False, destaque=None):
    """Desenha o estilo parado (como fica no meio da legenda) sobre um fundo escuro e salva um PNG."""
    from PIL import Image
    d = _def_estilo(defn)
    sp = _sprites_legenda(defn, texto, W, H)
    quadro = _quadro_legenda(sp, W, H, 5.0, 99.0, d["anim"])
    fundo = Image.new("RGBA", (W, H), (36, 36, 52, 255))
    fundo.alpha_composite(quadro)
    if guias:
        from PIL import ImageDraw
        g = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        dg = ImageDraw.Draw(g)
        dg.rectangle((0, 0, W - 1, H - 1), outline=(255, 255, 255, 200), width=2)  # bordas do vídeo
        mx, my = int(W * 0.05), int(H * 0.05)
        dg.rectangle((mx, my, W - mx, H - my), outline=(255, 214, 0, 220), width=2)  # margem de segurança (90%)
        dg.line((W // 2, 0, W // 2, H), fill=(0, 220, 255, 200), width=2)  # centro
        dg.line((0, H // 2, W, H // 2), fill=(0, 220, 255, 200), width=2)
        fundo.alpha_composite(g)
    caixas = []  # posição de cada linha (0 a 1 do quadro) para o painel desenhar a seleção e deixar arrastar
    _cams = _def_estilo(defn)["linhas"]
    _lin = dividir_em_linhas(texto, len(_cams))
    _lin += [""] * (len(_cams) - len(_lin))
    _vivos = [k for k, t in enumerate(_lin) if t]
    for n, (img, cx, cy) in enumerate(sp):
        bb = img.getchannel("A").point(lambda v: 255 if v > 40 else 0).getbbox()
        if bb and n < len(_vivos):
            ox, oy = cx - img.width / 2, cy - img.height / 2
            caixas.append({"k": _vivos[n], "x0": (ox + bb[0]) / W, "y0": (oy + bb[1]) / H, "x1": (ox + bb[2]) / W, "y1": (oy + bb[3]) / H})
    if destaque:  # moldura em volta das linhas marcadas
        from PIL import ImageDraw
        camadas = _def_estilo(defn)["linhas"]
        linhas = dividir_em_linhas(texto, len(camadas))
        linhas += [""] * (len(camadas) - len(linhas))
        vivos = [k for k, t in enumerate(linhas) if t]
        g = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        dg = ImageDraw.Draw(g)
        for k in destaque:
            if k not in vivos:
                continue
            img, cx, cy = sp[vivos.index(k)]
            bb = img.getchannel("A").point(lambda v: 255 if v > 40 else 0).getbbox()
            if not bb:
                continue
            x0, y0 = int(cx - img.width / 2) + bb[0] - 6, int(cy - img.height / 2) + bb[1] - 6
            x1, y1 = int(cx - img.width / 2) + bb[2] + 6, int(cy - img.height / 2) + bb[3] + 6
            dg.rectangle((x0, y0, x1, y1), outline=(255, 214, 10, 255), width=3)
            for qx, qy in ((x0, y0), (x1, y0), (x0, y1), (x1, y1)):
                dg.rectangle((qx - 5, qy - 5, qx + 5, qy + 5), fill=(255, 255, 255, 255), outline=(255, 214, 10, 255), width=2)
        fundo.alpha_composite(g)
    if recorte:  # miniatura: enquadra onde o texto realmente está (não só no meio do quadro)
        cw, ch = recorte
        if caixas:
            bx0, by0 = min(c["x0"] for c in caixas) * W, min(c["y0"] for c in caixas) * H
            bx1, by1 = max(c["x1"] for c in caixas) * W, max(c["y1"] for c in caixas) * H
            rh = max(float(ch), (by1 - by0) * 1.25, (bx1 - bx0) * 1.15 * ch / cw)
            rh = min(rh, float(H), W * ch / cw)
            rw = rh * cw / ch
            mx, my = (bx0 + bx1) / 2.0, (by0 + by1) / 2.0
            x0 = max(0.0, min(W - rw, mx - rw / 2))
            y0 = max(0.0, min(H - rh, my - rh / 2))
            fundo = fundo.crop((int(x0), int(y0), int(x0 + rw), int(y0 + rh))).resize((cw, ch), Image.LANCZOS)
        else:
            x0, y0 = (W - cw) // 2, int(H * 0.5 - ch / 2)
            fundo = fundo.crop((x0, y0, x0 + cw, y0 + ch))
    os.makedirs(os.path.dirname(saida_png), exist_ok=True)
    fundo.convert("RGB").save(saida_png)
    return caixas


def _fonte_nome(caminho):
    from PIL import ImageFont
    try:
        fam, est = ImageFont.truetype(caminho, 20).getname()
        return (fam + (" " + est if est and est.lower() not in ("regular", "normal") else "")).strip()
    except Exception:
        return os.path.splitext(os.path.basename(caminho))[0]


_CACHE_FONTES = None


def listar_fontes():
    global _CACHE_FONTES
    if _CACHE_FONTES is not None:
        return _CACHE_FONTES
    pastas = [os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "Windows", "Fonts"),
              os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "Fonts")]
    achadas = {}
    for p in pastas:
        if not os.path.isdir(p):
            continue
        for nome in os.listdir(p):
            base, ext = os.path.splitext(nome)
            if ext.lower() in (".ttf", ".otf") and base not in achadas:
                achadas[base] = _fonte_nome(os.path.join(p, nome))
    _CACHE_FONTES = sorted(({"id": k, "nome": v} for k, v in achadas.items()), key=lambda x: x["nome"].lower())
    return _CACHE_FONTES


def imagem_fonte(fonte_id):
    """PNG pequeno com o nome da fonte escrito nela mesma (para escolher a fonte no painel)."""
    from PIL import Image, ImageDraw, ImageFont
    achadas = {f["id"]: f["nome"] for f in listar_fontes()}
    if fonte_id not in achadas:
        raise RuntimeError("fonte desconhecida")
    pasta = os.path.join(_RAIZ, "cache", "fontes")
    os.makedirs(pasta, exist_ok=True)
    arq = os.path.join(pasta, re.sub(r"[^A-Za-z0-9_-]", "_", fonte_id) + ".png")
    if not os.path.isfile(arq):
        fonte = _achar_fonte(fonte_id, 24)
        txt = achadas[fonte_id]
        larg = min(420, int(fonte.getlength(txt)) + 20)
        img = Image.new("RGB", (max(60, larg), 36), (27, 27, 38))
        ImageDraw.Draw(img).text((10, 18), txt, font=fonte, fill=(240, 240, 248), anchor="lm")
        img.save(arq)
    return arq


def salvar_estilo(nome, defn):
    nome = _nome_seguro(nome)
    if not nome:
        raise RuntimeError("Dê um nome ao estilo (só letras, números e espaços).")
    if nome in ESTILOS_OVERLAY or nome in ESTILOS or nome == "aleatorio":
        raise RuntimeError("Esse nome já é de um modelo pronto. Escolha outro.")
    d = _limpar_def(defn)
    os.makedirs(_pasta_estilos(), exist_ok=True)
    slug = re.sub(r"\s+", "_", nome)
    with open(os.path.join(_pasta_estilos(), slug + ".json"), "w", encoding="utf-8") as f:
        json.dump({"nome": nome, "def": d}, f, ensure_ascii=False, indent=1)
    renderizar_previa(d, "Seu texto aparece aqui", os.path.join(_RAIZ, "painel", "img", slug + ".png"))
    return {"nome": nome}


def excluir_estilo(nome):
    nome = _nome_seguro(nome)
    slug = re.sub(r"\s+", "_", nome)
    for arq in (os.path.join(_pasta_estilos(), slug + ".json"), os.path.join(_RAIZ, "painel", "img", slug + ".png")):
        if os.path.isfile(arq):
            os.remove(arq)
    return {"ok": True}


def _registro_overlay(novos=None):
    """Guarda (num arquivo) o texto e o estilo de cada legenda desenhada, para poder editar depois."""
    arq = os.path.join(_RAIZ, "cache", "overlays", "textos.json")
    try:
        with open(arq, encoding="utf-8") as f:
            dados = json.load(f)
    except Exception:
        dados = {}
    if novos:
        dados.update(novos)
        os.makedirs(os.path.dirname(arq), exist_ok=True)
        with open(arq, "w", encoding="utf-8") as f:
            json.dump(dados, f, ensure_ascii=False)
    return dados


def limpar_overlays(em_uso, horas=24):
    """Apaga do disco as legendas desenhadas que não estão mais no projeto (só as de mais de
    'horas' horas, para o Ctrl+Z do Premiere ainda funcionar). Devolve quantos arquivos saíram."""
    import time
    raiz = os.path.join(_RAIZ, "cache", "overlays")
    usados = {os.path.basename(str(n)) for n in (em_uso or [])}
    apagados = []
    limite = time.time() - horas * 3600
    for pasta, _dirs, arquivos in os.walk(raiz):
        for nome in arquivos:
            if not nome.lower().endswith(".mov") or nome in usados:
                continue
            caminho = os.path.join(pasta, nome)
            try:
                if os.path.getmtime(caminho) < limite:
                    os.remove(caminho)
                    apagados.append(nome)
            except OSError:
                pass
    for pasta, _dirs, _arq in os.walk(raiz, topdown=False):  # pastas vazias
        if pasta != raiz:
            try:
                os.rmdir(pasta)
            except OSError:
                pass
    if apagados:
        arq = os.path.join(raiz, "textos.json")
        try:
            dados = _registro_overlay()
            for n in apagados:
                dados.pop(n, None)
            with open(arq, "w", encoding="utf-8") as f:
                json.dump(dados, f, ensure_ascii=False)
        except Exception:
            pass
    return {"apagados": len(apagados)}


def gerar_overlay(blocos, estilo, W, H, fps, saida, separado=False):
    """blocos: [(inicio, fim, texto)] em segundos (já em ordem). Gera UM vídeo .mov com transparência."""
    import tempfile
    anim_est = _def_estilo(estilo)["anim"]
    W, H = int(W) // 2 * 2, int(H) // 2 * 2
    fps = float(fps)
    pasta = tempfile.mkdtemp(prefix="ovl_")
    partes = []
    cursor = None  # quadro onde terminou a parte anterior
    blocos = sorted(blocos)
    # termina cada legenda antes da próxima começar
    ajust = []
    for i, (a, b, tx) in enumerate(blocos):
        if i + 1 < len(blocos):
            b = min(b, blocos[i + 1][0] - 1.0 / fps)
        if b - a >= 0.3:
            ajust.append((a, b, tx))
    if not ajust:
        raise RuntimeError("Nenhuma legenda para desenhar.")
    t0 = ajust[0][0]
    enc = ["-c:v", "qtrle", "-pix_fmt", "argb"]

    def _ffmpeg_gap(n, arq):
        subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                        "color=c=black@0.0:s=%dx%d:r=%s,format=rgba" % (W, H, fps), "-frames:v", str(n)] + enc + [arq],
                       check=True)

    if separado:  # um arquivo por legenda (cada uma vira um clipe que dá para mover e aparar)
        pasta_sep = os.path.splitext(saida)[0] + "_legendas"
        os.makedirs(pasta_sep, exist_ok=True)
        lista_sep = []
        for i, (a, b, tx) in enumerate(ajust):
            n = max(2, int(round((b - a) * fps)))
            sp = _sprites_legenda(estilo, tx, W, H)
            arq = os.path.join(pasta_sep, "leg%05d_%s.mov" % (i + 1, os.path.basename(saida)[8:-4]))
            p = subprocess.Popen(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba",
                                  "-s", "%dx%d" % (W, H), "-r", str(fps), "-i", "-"] + enc + [arq], stdin=subprocess.PIPE)
            dur = n / fps
            estatico = None
            t_ent = _tempo_entrada(anim_est, len(sp))
            for k in range(n):
                t = k / fps
                if t_ent < t < dur - 0.2:
                    if estatico is None:
                        estatico = _quadro_legenda(sp, W, H, 99.0, 1e6, anim_est).tobytes()
                    p.stdin.write(estatico)
                else:
                    p.stdin.write(_quadro_legenda(sp, W, H, t, dur, anim_est).tobytes())
            p.stdin.close()
            if p.wait() != 0:
                raise RuntimeError("O ffmpeg falhou ao desenhar a legenda %d." % (i + 1))
            lista_sep.append({"arquivo": arq, "a": a, "b": b, "texto": tx})
        import shutil
        shutil.rmtree(pasta, ignore_errors=True)
        _registro_overlay({os.path.basename(x["arquivo"]): {"texto": x["texto"], "estilo": estilo} for x in lista_sep})
        return {"itens": lista_sep, "legendas": len(lista_sep)}
    for i, (a, b, tx) in enumerate(ajust):
        fa = int(round((a - t0) * fps))
        fb = max(fa + 2, int(round((b - t0) * fps)))
        if cursor is not None and fa > cursor:
            arq = os.path.join(pasta, "g%05d.mov" % i)
            _ffmpeg_gap(fa - cursor, arq)
            partes.append(arq)
        elif cursor is not None:
            fa = cursor
        n = fb - fa
        sp = _sprites_legenda(estilo, tx, W, H)
        arq = os.path.join(pasta, "c%05d.mov" % i)
        p = subprocess.Popen(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba",
                              "-s", "%dx%d" % (W, H), "-r", str(fps), "-i", "-"] + enc + [arq],
                             stdin=subprocess.PIPE)
        dur = n / fps
        estatico = None
        t_ent = _tempo_entrada(anim_est, len(sp))
        for k in range(n):
            t = k / fps
            if t_ent < t < dur - 0.2:
                if estatico is None:
                    estatico = _quadro_legenda(sp, W, H, 99.0, 1e6, anim_est).tobytes()
                p.stdin.write(estatico)
            else:
                p.stdin.write(_quadro_legenda(sp, W, H, t, dur, anim_est).tobytes())
        p.stdin.close()
        if p.wait() != 0:
            raise RuntimeError("O ffmpeg falhou ao desenhar a legenda %d." % (i + 1))
        partes.append(arq)
        cursor = fa + n
    lista = os.path.join(pasta, "lista.txt")
    with open(lista, "w", encoding="utf-8") as f:
        for arq in partes:
            f.write("file '%s'\n" % arq.replace("\\", "/"))
    os.makedirs(os.path.dirname(saida), exist_ok=True)
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lista,
                    "-c", "copy", saida], check=True)
    import shutil
    shutil.rmtree(pasta, ignore_errors=True)
    return {"arquivo": saida, "inicio": t0, "legendas": len(ajust), "fim": ajust[-1][1]}


CAIXA_ALTA = {"Criativo 1": [False, True, False], "Criativo 2": [True, False, True],
              "Criativo 3": [True, False], "Criativo 4": [False, False, False, False]}


def dividir_em_linhas(texto, n):
    """Reparte o texto em n linhas equilibradas (por letras). Se faltar palavra, completa com vazio."""
    pal = texto.split()
    if not pal:
        return [""] * n
    n = max(1, min(n, len(pal)))
    total = sum(len(p) for p in pal) + len(pal) - 1
    alvo = total / n
    linhas, atual = [], []
    for i, p in enumerate(pal):
        restam_pal = len(pal) - i
        restam_lin = n - len(linhas)
        if atual and restam_lin > 1 and (len(" ".join(atual + [p])) > alvo * 1.15 or restam_pal < restam_lin):
            linhas.append(atual)
            atual = []
        atual.append(p)
    linhas.append(atual)
    return [" ".join(l) for l in linhas]


def legendas_estilizadas(wav, inicio, fim, modo, estilo, pasta_saida, enxuto, semente,
                         cache=None, prefixo="", overlay=True):
    import random

    cache = cache or (os.path.splitext(wav)[0] + "_palavras.json")
    if not os.path.isfile(cache):
        raise RuntimeError("Falta a transcrição por palavra deste trecho.")
    with open(cache, encoding="utf-8") as f:
        palavras = [p for p in json.load(f) if inicio <= p["s"] < fim]
    if not palavras:
        raise RuntimeError("Não há falas nesse intervalo.")
    blocos = (legendas_palavra_a_palavra(palavras) if modo == "curtas"
              else legendas_em_blocos(palavras, max_chars=(24 if eh_estilo_overlay(estilo) else 30),
                                      max_dur=3.0))
    sorteio = random.Random(semente)
    nomes = list(ESTILOS)
    os.makedirs(pasta_saida, exist_ok=True)
    saida = []
    for i, (ini, fi, texto) in enumerate(blocos):
        texto = re.sub(r"(\w) -(\w)", r"\1-\2", texto)  # "Bem -vindos" -> "Bem-vindos"
        est = sorteio.choice(nomes) if estilo == "aleatorio" else estilo
        if (est in MODELOS_PROJETO or est in estilos_usuario()) and overlay:  # desenhado pelo programa (um vídeo transparente só)
            saida.append({"ini": ini, "fim": fi, "texto": texto, "estilo": est, "tipo": "overlay"})
            continue
        if est in MODELOS_PROJETO:  # modelo artístico guardado em projeto do Premiere
            cfg = MODELOS_PROJETO[est]
            n = len(cfg["camadas"])
            linhas = dividir_em_linhas(texto, n)
            linhas += [""] * (n - len(linhas))
            linhas = [(l.upper() if cx else l) for l, cx in zip(linhas, CAIXA_ALTA.get(est, [False] * n))]
            prep = preparar_modelo_projeto(est, linhas)
            saida.append({"ini": ini, "fim": fi, "texto": texto, "estilo": est, "tipo": "projeto",
                          "arquivo": prep["caminho"], "guid": prep["guid"], "nome": prep["nome"]})
            continue
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


avaliar_audios = com_cache(avaliar_audios)
plano_podcast = com_cache(plano_podcast)


def crops_vertical(cameras, geral, pecas):
    """Só procura os rostos. pecas: [{"arq": {"V1": [ini, fim], ...}}] (tempos DENTRO de cada arquivo de vídeo).
    Os cortes já existem na sequência; aqui se decide apenas o enquadramento vertical de cada câmera."""
    import numpy as np
    ultimo = {}
    saida = []
    for p in pecas:
        crops = {}
        for cam in cameras:
            a, b = p["arq"][cam]
            W, H, amostras = rostos_no_trecho(cameras[cam], a, b)
            escolhidos = []
            for _, faces in amostras:
                if not faces:
                    continue
                if cam == geral and len(faces) > 1:
                    escolhidos.append((float(np.mean([f[0] for f in faces])), float(np.mean([f[1] for f in faces])),
                                       float(max(f[3] for f in faces))))
                else:
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
            crops[cam] = {"largura": W, "altura": H, "cx": cx, "cy": cy, "fh": fh, "rostos": n}
        saida.append(crops)
    return {"crops": saida}


crops_vertical = com_cache(crops_vertical)


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

_GANCHOS = ["voce sabia", "imagina", "ninguem", "nunca", "segredo", "a verdade", "descobri", "percebi", "de repente",
            "foi quando", "ate que", "nao acredito", "o problema", "o maior erro", "por que", "pare de", "cuidado",
            "sabe o que", "eu achava", "eu pensava", "tudo mudou", "a partir daquele", "naquele dia", "eu nao aguentava"]
_EMOCAO = ["amor", "deus", "perdao", "perdoa", "medo", "dor", "vergonha", "famili", "traic", "milagre", "liberta",
           "cura", "curad", "chor", "sofr", "morte", "morr", "vicio", "droga", "depress", "ansied", "raiva", "odio",
           "mae", "pai", "filho", "filha", "casamento", "marido", "esposa", "separa", "divorc", "esperanca", "fe",
           "transform", "mudou", "mudanca", "coragem", "culpa", "sozinh", "abandon", "vitoria", "propósito", "proposito"]
_INICIO_FRACO = ("e", "mas", "entao", "ai", "porque", "que", "ou", "pois", "tipo", "ne", "so")


def trechos_virais(wav, dmin=20.0, dmax=60.0, quantidade=8):
    """Procura, na transcrição por palavra, trechos com cara de corte curto que prende: começa com gancho,
    pensamento completo, emoção, ritmo bom. Nota de 0 a 100 + motivos. Tempos = tempos do arquivo de áudio."""
    cache = os.path.splitext(wav)[0] + "_palavras.json"
    if not os.path.isfile(cache):
        raise RuntimeError("Falta a transcrição do podcast. Na aba Legendas, clique em "
                           "'Transcrever o podcast (por palavra)' (só precisa fazer uma vez).")
    with open(cache, encoding="utf-8") as f:
        palavras = json.load(f)
    if not transcricao_completa(palavras, wav):
        raise RuntimeError("Falta a transcrição completa do podcast (a guardada cobre só um pedaço).")
    frases, atual = [], []
    for p in palavras:
        if atual and p["s"] - atual[-1]["e"] > 0.9:
            frases.append(atual)
            atual = []
        atual.append(p)
        if p["w"][-1:] in ".?!" and len(atual) >= 3:
            frases.append(atual)
            atual = []
    if atual:
        frases.append(atual)
    norm_f = [_norm(" ".join(x["w"] for x in fr)) for fr in frases]
    cands = []
    n = len(frases)
    for i in range(n):
        ini = frases[i][0]["s"]
        for j in range(i, n):
            fim = frases[j][-1]["e"]
            dur = fim - ini
            if dur > dmax:
                break
            if dur < dmin:
                continue
            ws = [w for fr in frases[i:j + 1] for w in fr]
            txt_n = " ".join(norm_f[i:j + 1])
            motivos, nota = [], 0.0
            prim = norm_f[i]
            if any(g in prim for g in _GANCHOS) or frases[i][-1]["w"].endswith("?"):
                nota += 3.0; motivos.append("começa com gancho")
            if len(frases[i]) <= 12:
                nota += 1.0
            toks = txt_n.split()
            emo = sum(1 for t in toks if any(t.startswith(r) for r in _EMOCAO))
            dens = emo / max(1, len(toks)) * 100
            if emo:
                nota += min(4.0, dens * 0.7); motivos.append("assunto forte/emocional")
            qex = sum(1 for fr in frases[i:j + 1] if fr[-1]["w"][-1:] in "?!")
            if qex:
                nota += min(2.0, qex * 0.6); motivos.append("perguntas/ênfase")
            taxa = len(ws) / max(1.0, dur)
            if 2.2 <= taxa <= 3.6:
                nota += 1.0; motivos.append("ritmo bom")
            elif taxa < 1.6:
                nota -= 1.5
            pausas = sum(1 for a, b in zip(ws, ws[1:]) if b["s"] - a["e"] > 1.5)
            nota -= min(3.0, pausas * 1.0)
            if frases[j][-1]["w"][-1:] in ".!?":
                nota += 1.0; motivos.append("termina fechando a ideia")
            if toks and toks[0] in _INICIO_FRACO:
                nota -= 1.5
            centro = (dmin + dmax) / 2
            nota += 1.0 - abs(dur - centro) / max(1.0, (dmax - dmin) / 2)
            cands.append((nota, ini, fim, i, j, motivos))
    cands.sort(key=lambda c: -c[0])
    escolhidos = []
    for c in cands:
        if all(c[2] <= e[1] or c[1] >= e[2] for e in escolhidos):
            escolhidos.append(c)
        if len(escolhidos) >= int(quantidade):
            break
    saida = []
    for nota, ini, fim, i, j, motivos in escolhidos:
        txt = " ".join(w["w"] for fr in frases[i:j + 1] for w in fr)
        vistos = []
        for mt in motivos:
            if mt not in vistos:
                vistos.append(mt)
        saida.append({"ini": round(ini, 2), "fim": round(fim, 2), "nota": int(max(1, min(99, round(nota / 12.0 * 100)))),
                      "motivos": vistos, "texto": (txt[:200] + "...") if len(txt) > 200 else txt})
    saida.sort(key=lambda x: -x["nota"])
    return {"trechos": saida}


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
        elif self.path == "/icone/conta_gotas.png":
            dados = _png_conta_gotas(32)
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(dados)))
            self.end_headers()
            self.wfile.write(dados)
        elif self.path.startswith("/painel/img/"):
            nome = os.path.basename(self.path.split("?")[0])
            arq = os.path.join(_RAIZ, "painel", "img", nome)
            if re.fullmatch(r"[A-Za-z0-9_-]+\.(png|jpg|gif)", nome) and os.path.isfile(arq):
                dados = open(arq, "rb").read()
                self.send_response(200)
                self.send_header("Content-Type", "image/" + ("jpeg" if nome.endswith("jpg") else nome.rsplit(".", 1)[1]))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(dados)))
                self.end_headers()
                self.wfile.write(dados)
            else:
                self._responder({"erro": "imagem não encontrada"}, 404)
        elif self.path == "/estilos":
            usuario = estilos_usuario()
            try:  # miniaturas antigas podiam sair em branco: refaz uma vez a cada versão
                marca = os.path.join(_RAIZ, "painel", "img", "miniaturas_v.txt")
                if not (os.path.isfile(marca) and open(marca, encoding="utf-8").read().strip() == VERSAO):
                    for n_, d_ in usuario.items():
                        renderizar_previa(d_, "Seu texto aparece aqui", os.path.join(_RAIZ, "painel", "img", re.sub(r"\s+", "_", n_) + ".png"))
                    os.makedirs(os.path.dirname(marca), exist_ok=True)
                    open(marca, "w", encoding="utf-8").write(VERSAO)
            except Exception:
                pass
            todos = [{"nome": n, "def": _limpar_def({"linhas": l}), "usuario": False} for n, l in ESTILOS_OVERLAY.items()]
            todos += [{"nome": n, "def": d, "usuario": True} for n, d in usuario.items()]
            self._responder({"estilos": todos})
        elif self.path.startswith("/fonte/img"):
            import urllib.parse
            try:
                q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                arq = imagem_fonte(q.get("id", [""])[0])
                dados = open(arq, "rb").read()
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(dados)))
                self.end_headers()
                self.wfile.write(dados)
            except Exception as e:
                self._responder({"erro": str(e)}, 404)
        elif self.path == "/estilos/fontes":
            self._responder({"fontes": listar_fontes()})
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
            if self.path == "/legendas_overlay":
                import time
                pasta_ov = os.path.join(_RAIZ, "cache", "overlays")
                nome_ov = "overlay_%s_%d.mov" % (re.sub(r"\W", "", corpo.get("estilo", "x")), int(time.time()))
                blocos = [(float(b["a"]), float(b["b"]), str(b["texto"])) for b in corpo["blocos"]]
                return self._responder(gerar_overlay(blocos, corpo.get("estilo"), corpo.get("w", 1920),
                                                     corpo.get("h", 1080), corpo.get("fps", 30),
                                                     os.path.join(pasta_ov, nome_ov),
                                                     bool(corpo.get("separado", False))))

            if self.path == "/criativo/previa":
                try:
                    criativo_previa(corpo.get("def") or {}, os.path.join(_RAIZ, "painel", "img", "prev_criativo.png"),
                                    corpo.get("formato") == "v")
                    return self._responder({"ok": True})
                except Exception as e:
                    return self._responder({"erro": str(e)}, 400)
            if self.path == "/criativo/gerar":
                import time
                nome = "criativo_%d.mov" % int(time.time())
                return self._responder(criativo_gerar(corpo.get("def") or {}, corpo.get("w", 1920), corpo.get("h", 1080),
                                                      corpo.get("fps", 30), corpo.get("dur", 5),
                                                      os.path.join(_RAIZ, "cache", "criativos", nome)))
            if self.path == "/texto_trecho":
                return self._responder(texto_do_trecho(
                    caminho, float(corpo.get("inicio", 0)), float(corpo.get("fim", 60)),
                    corpo.get("model", "small"), corpo.get("device", "cpu"), corpo.get("language", "pt")))

            if self.path == "/avaliar_audios":
                cams = corpo.get("cameras") or {}
                for o in list(cams.values()) + [f["path"] for f in corpo.get("faixas", [])]:
                    if not os.path.isfile(o):
                        return self._responder({"erro": f"arquivo não encontrado: {o}"}, 400)
                return self._responder(avaliar_audios(corpo.get("faixas", []), cams, corpo.get("pessoas", []), corpo.get("recorte")))

            if self.path == "/estilo/salvar":
                try:
                    return self._responder(salvar_estilo(corpo.get("nome", ""), corpo.get("def") or {}))
                except Exception as e:
                    return self._responder({"erro": str(e)}, 400)
            if self.path == "/estilo/excluir":
                return self._responder(excluir_estilo(corpo.get("nome", "")))
            if self.path == "/cor_tela":
                try:
                    modo = corpo.get("modo")
                    if modo == "inicio":
                        _cursor_conta_gotas(True)
                        return self._responder({"ok": True})
                    if modo == "fim":
                        _cursor_conta_gotas(False)
                        return self._responder({"ok": True})
                    return self._responder(cor_da_tela())
                except Exception as e:
                    return self._responder({"erro": str(e)}, 400)
            if self.path == "/estilo/previa":
                try:
                    vert = corpo.get("formato") == "v"
                    caixas = renderizar_previa(corpo.get("def") or {}, corpo.get("texto") or "Seu texto aparece aqui",
                                      os.path.join(_RAIZ, "painel", "img", "prev_editor.png"),
                                      W=720 if vert else 1280, H=1280 if vert else 720, recorte=None,
                                      guias=bool(corpo.get("guias")), destaque=[int(x) for x in (corpo.get("destaque") or [])])
                    return self._responder({"ok": True, "caixas": caixas})
                except Exception as e:
                    return self._responder({"erro": str(e)}, 400)
            if self.path == "/legenda/limpar_disco":
                return self._responder(limpar_overlays(corpo.get("emUso", [])))
            if self.path == "/legenda/info_lote":
                reg = _registro_overlay()
                return self._responder({"infos": [reg.get(os.path.basename(str(n))) for n in corpo.get("nomes", [])]})
            if self.path == "/legenda/info":
                info = _registro_overlay().get(os.path.basename(str(corpo.get("nome", ""))))
                return self._responder(info or {"erro": "Não achei o texto dessa legenda. Só dá para editar legendas Criativo feitas por esta versão."}, 200 if info else 404)
            if self.path == "/modelo/preparar":
                try:
                    return self._responder(preparar_modelo_projeto(corpo.get("modelo", ""), corpo.get("linhas", [])))
                except Exception as e:
                    return self._responder({"erro": str(e)}, 400)
            if self.path == "/previa_estilos":
                pasta = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "mogrts"))
                os.makedirs(pasta, exist_ok=True)
                dur = float(corpo.get("duracao", 3.0))
                saida = []
                for nome in ESTILOS:
                    base = os.path.join(pasta_templates(), ESTILOS[nome])
                    if not os.path.isfile(base):
                        continue
                    destino = os.path.join(pasta, "previa_" + nome + ".mogrt")
                    gerar_mogrt(base, "Aprendendo sobre o Amor Inteligente", destino, nome="AutoCut " + nome,
                                enxuto=True, duracao=dur, tempos=None, limpar_extras=False)
                    saida.append({"estilo": nome, "arquivo": destino})
                if not saida:
                    return self._responder({"erro": "Não achei os templates de legenda do Premiere."}, 400)
                return self._responder({"previas": saida})
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

            if self.path == "/equalizar":
                import time
                saida = os.path.join(_RAIZ, "cache", "equalizado", "eq_%d.wav" % int(time.time()))
                return self._responder(equalizar_audio(
                    caminho, saida, canais=corpo.get("canais"), canal=corpo.get("canal"),
                    trechos=corpo.get("trechos"), recorte=corpo.get("recorte"),
                    alvo_db=float(corpo.get("alvoDb", -20.0))))

            if self.path == "/vozes":
                cams = corpo.get("cameras") or {}
                for o in cams.values():
                    if not os.path.isfile(o):
                        return self._responder({"erro": f"arquivo não encontrado: {o}"}, 400)
                pessoas = corpo.get("pessoas") or []
                res = vozes_na_trilha(caminho, max(1, int(corpo.get("n") or len(pessoas) or 2)),
                                      canal=corpo.get("canal"), recorte=corpo.get("recorte"))
                lig = ligar_vozes_as_pessoas(res, caminho, pessoas, cams, corpo.get("recorte"))
                return self._responder({"trechos": res["trechos"], "tempo": res["tempo"],
                                        "mapa": {str(k): v for k, v in lig["mapa"].items()},
                                        "confiavel": lig["confiavel"],
                                        "amostras": {str(k): v for k, v in lig["amostras"].items()},
                                        "margem": lig.get("margem"), "kSugerido": res.get("kSugerido")})

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

            if self.path == "/virais":
                try:
                    return self._responder(trechos_virais(caminho, float(corpo.get("min", 20)), float(corpo.get("max", 60)), int(corpo.get("quantidade", 8))))
                except Exception as e:
                    return self._responder({"erro": str(e)}, 400)
            if self.path == "/crops_vertical":
                for nome_c, o in corpo["cameras"].items():
                    if not isinstance(o, str) or not os.path.isfile(o):
                        return self._responder({"erro": f"arquivo da câmera {nome_c} não encontrado: {o!r}"}, 400)
                return self._responder(crops_vertical(corpo["cameras"], corpo.get("geral", "V1"), corpo["pecas"]))
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
                    corpo.get("apresentadores") or corpo.get("apresentador"), int(corpo.get("prioridade", 0)),
                    corpo.get("trechosProntos"), corpo.get("recorte"), corpo.get("corrigirCamera")))

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
    destinos["base_modelos.prproj"] = os.path.join(_RAIZ, "modelos", "base_modelos.prproj")
    for nome in (info.get("arquivos") or {}):
        if re.fullmatch(r"img_[A-Za-z0-9_-]+\.png", nome):
            destinos[nome] = os.path.join(_RAIZ, "painel", "img", nome[4:])
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
