const SERVICO = "http://127.0.0.1:8765";

const $ = (id) => document.getElementById(id);
const status = $("status");

function mostrar(texto, erro = false) {
  status.textContent = texto;
  status.className = erro ? "erro" : "";
}

async function chamar(rota, corpo) {
  const resposta = await fetch(SERVICO + rota, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });
  const dados = await resposta.json();
  if (!resposta.ok || dados.erro) throw new Error(dados.erro || "Erro no serviço local");
  return dados;
}

// Cada ajuste é um número inteiro que sobe e desce com os botões − e +,
// e é convertido para o valor real usado no corte.
const arred = (x) => Math.round(x * 100) / 100;
const AJUSTES = {
  limite:  { converter: (v) => v - 60,                inicial: 29, min: 0, max: 45, sufixo: "dB", casas: 0, rotulo: "valLimite" },
  minimo:  { converter: (v) => arred(0.1 + v * 0.05), inicial: 8,  min: 0, max: 28, sufixo: "s",  casas: 2, rotulo: "valMinimo" },
  respiro: { converter: (v) => arred(v * 0.05),       inicial: 5,  min: 0, max: 12, sufixo: "s",  casas: 2, rotulo: "valRespiro" },
};
const estado = {};
Object.keys(AJUSTES).forEach((id) => { estado[id] = AJUSTES[id].inicial; });

function valorReal(id) {
  return AJUSTES[id].converter(estado[id]);
}

function mostrarAjuste(id) {
  const cfg = AJUSTES[id];
  const rotulo = $(cfg.rotulo);
  if (rotulo) rotulo.textContent = valorReal(id).toFixed(cfg.casas).replace(".", ",") + " " + cfg.sufixo;
}

function ligarAjuste(id) {
  const cfg = AJUSTES[id];
  const passo = (delta) => {
    estado[id] = Math.min(cfg.max, Math.max(cfg.min, estado[id] + delta));
    mostrarAjuste(id);
  };
  const menos = $(id + "Menos");
  const mais = $(id + "Mais");
  if (menos) menos.addEventListener("click", () => passo(-1));
  if (mais) mais.addEventListener("click", () => passo(1));
  mostrarAjuste(id);
}
Object.keys(AJUSTES).forEach(ligarAjuste);

// Lê o valor real de um ajuste (limite, minimo ou respiro).
function lerNumero(id) {
  return valorReal(id);
}

function segundos(n) {
  return n.toFixed(2) + "s";
}

// --- Vídeo: o que foi digitado, ou o vídeo da sequência ativa --------------
// Se você digitar/colar um caminho, ele é usado. Se o campo estiver vazio (ou
// tiver sido preenchido pelo próprio painel), o vídeo vem da sequência ativa.
let caminhoManual = false;
$("caminho").addEventListener("input", () => {
  caminhoManual = $("caminho").value.trim() !== "";
});

// Devolve os arquivos de vídeo usados na sequência: Map(caminho -> nome do clipe).
async function videosDaSequencia(ppro, sequencia) {
  const achados = new Map();
  let ultimoErro = null;
  const nTrilhas = await sequencia.getVideoTrackCount();
  for (let i = 0; i < nTrilhas; i++) {
    const trilha = await sequencia.getVideoTrack(i);
    const itens = await trilha.getTrackItems(1, false); // 1 = clipes
    for (const item of itens) {
      try {
        const projectItem = await item.getProjectItem();
        const clip = await ppro.ClipProjectItem.cast(projectItem);
        const caminho = await clip.getMediaFilePath();
        if (caminho && !achados.has(caminho)) {
          achados.set(caminho, projectItem.name || caminho);
        }
      } catch (e) { ultimoErro = e; }
    }
  }
  if (achados.size === 0 && ultimoErro) throw ultimoErro;
  return achados;
}

// Devolve o caminho do vídeo a usar, ou null (e já mostra o motivo no painel).
async function obterCaminho() {
  const digitado = $("caminho").value.trim();
  if (caminhoManual && digitado) return digitado;
  try {
    const ppro = require("premierepro");
    const projeto = await ppro.Project.getActiveProject();
    const sequencia = await projeto.getActiveSequence();
    if (!sequencia) {
      mostrar("Nenhuma sequência ativa. Clique numa sequência na timeline, ou cole o caminho do vídeo.", true);
      return null;
    }
    const achados = await videosDaSequencia(ppro, sequencia);
    if (achados.size === 0) {
      mostrar("Não achei nenhum vídeo na sequência " + sequencia.name + ". Coloque o clipe na timeline, ou cole o caminho do vídeo.", true);
      return null;
    }
    if (achados.size > 1) {
      const nomes = Array.from(achados.values()).slice(0, 6).map((n) => "- " + n).join("\n");
      mostrar("A sequência " + sequencia.name + " tem " + achados.size + " vídeos diferentes:\n" + nomes +
        "\nCole no campo o caminho do que você quer cortar.", true);
      return null;
    }
    const caminho = achados.keys().next().value;
    $("caminho").value = caminho;
    return caminho;
  } catch (e) {
    mostrar("Não consegui ler o vídeo da sequência ativa:\n" + (e && e.message ? e.message : e) +
      "\nCole o caminho do vídeo no campo.", true);
    return null;
  }
}

$("btnUsarSequencia").addEventListener("click", async () => {
  caminhoManual = false;
  $("caminho").value = "";
  const caminho = await obterCaminho();
  if (caminho) mostrar("Vídeo da sequência ativa:\n" + caminho);
});

// --- Passo 1: confirmar que o painel enxerga o Premiere -------------------
// A API UXP do Premiere ainda está evoluindo; se algum nome abaixo falhar na
// sua versão, confira em developer.adobe.com/premiere-pro/uxp e ajuste.
$("btnPremiere").addEventListener("click", async () => {
  try {
    const ppro = require("premierepro");
    const projeto = await ppro.Project.getActiveProject();
    const sequencia = await projeto.getActiveSequence();
    mostrar(
      "Conectado ao Premiere.\nProjeto: " + projeto.name +
      "\nSequência ativa: " + (sequencia ? sequencia.name : "(nenhuma)")
    );
  } catch (e) {
    mostrar("Não consegui falar com o Premiere:\n" + e.message, true);
  }
});

// --- Sondagem: descobre quais recursos a API do SEU Premiere oferece -------
// Serve para eu escrever o corte e as legendas só com comandos que existem.
$("btnSondar").addEventListener("click", () => {
  try {
    const ppro = require("premierepro");
    const filtro = /caption|subtitle|insert|overwrite|inpoint|outpoint|import|createsequence|clone|subclip|mediafilepath|path|remove|razor|transaction|locked|trackitem|getitems|getrootitem/i;
    const classes = [
      "Project", "ProjectItem", "ClipProjectItem", "FolderItem",
      "Sequence", "SequenceEditor", "CaptionTrack", "VideoTrack", "AudioTrack",
      "TrackItem", "VideoClipTrackItem", "TickTime",
    ];
    const linhas = [];
    for (const nome of classes) {
      const C = ppro[nome];
      if (!C) { linhas.push(nome + ": (não existe)"); continue; }
      const achados = new Set();
      const coletar = (obj, prefixo) => {
        try {
          Object.getOwnPropertyNames(obj).forEach((n) => {
            if (n !== "constructor" && filtro.test(n)) achados.add(prefixo + n);
          });
        } catch (e) { /* ignora */ }
      };
      coletar(C, "");
      if (C.prototype) coletar(C.prototype, "");
      linhas.push(nome + ": " + (achados.size ? Array.from(achados).join(", ") : "(nada relevante)"));
    }
    const topo = Object.keys(ppro).filter((n) => filtro.test(n));
    if (topo.length) linhas.push("Nível superior: " + topo.join(", "));
    console.log(linhas.join("\n"));
    mostrar(linhas.join("\n\n"));
  } catch (e) {
    mostrar("Falha na sondagem:\n" + e.message, true);
  }
});

// --- Teste de corte: coloca 3 trechos numa SEQUÊNCIA NOVA -------------------
// Não mexe na sua sequência original. Os nomes dos comandos vieram da
// sondagem; os parâmetros ainda não foram confirmados, então erros são esperados
// e servem para eu ajustar.
function dormir(ms) { return new Promise((r) => setTimeout(r, ms)); }
function normalizar(p) { return String(p || "").replace(/\//g, "\\").toLowerCase(); }

async function acharClipe(ppro, projeto, caminho) {
  const alvo = normalizar(caminho);
  async function varrer(pasta) {
    const itens = await pasta.getItems();
    for (const item of itens) {
      let caminhoItem = null;
      let clip = null;
      try {
        clip = ppro.ClipProjectItem.cast(item);
        caminhoItem = await clip.getMediaFilePath();
      } catch (e) { caminhoItem = null; }
      if (caminhoItem !== null && caminhoItem !== undefined) {
        if (normalizar(caminhoItem) === alvo) return { clip, item };
        continue;
      }
      try {
        const achado = await varrer(ppro.FolderItem.cast(item));
        if (achado) return achado;
      } catch (e) { /* não era pasta */ }
    }
    return null;
  }
  return varrer(await projeto.getRootItem());
}

// Cada passo roda sozinho, para o Premiere aplicar um antes de começar o outro.
async function executar(projeto, nome, criarAcao) {
  projeto.lockedAccess(() => {
    projeto.executeTransaction((composto) => {
      composto.addAction(criarAcao());
    }, nome);
  });
  await dormir(400);
}

$("btnTesteCorte").addEventListener("click", async () => {
  const caminho = await obterCaminho();
  if (!caminho) return;
  let etapa = "começando";
  let diagnostico = "";
  try {
    const ppro = require("premierepro");
    etapa = "abrir o projeto";
    const projeto = await ppro.Project.getActiveProject();

    etapa = "procurar o vídeo dentro do projeto";
    let achado = await acharClipe(ppro, projeto, caminho);
    if (!achado) {
      await projeto.importFiles([caminho]);
      await dormir(1500);
      achado = await acharClipe(ppro, projeto, caminho);
      if (!achado) {
        return mostrar("O vídeo não estava no projeto. Tentei importar, mas ainda não o encontrei. Olhe o painel Projeto, confira se ele apareceu e clique de novo.", true);
      }
    }
    const clip = achado.clip;          // versão "clipe": entrada/saída e criar sequência
    const itemOriginal = achado.item;  // item como o projeto o entrega: colocar na timeline

    etapa = "calcular os trechos de fala";
    const r = await chamar("/silences", {
      path: caminho,
      noiseDb: lerNumero("limite", -31),
      minSilence: lerNumero("minimo", 0.5),
      padding: lerNumero("respiro", 0.25),
    });
    const trechos = r.keep.filter(([a, b]) => b - a >= 1).slice(0, 3);
    if (!trechos.length) return mostrar("Não achei trechos de fala com mais de 1 segundo.", true);

    // A sequência é criada a partir do próprio vídeo (já nasce com as trilhas
    // certas) e o 1º trecho define o que entra nela. Os demais vão depois.
    let posicao = 0;
    let editor = null;
    let sequencia = null;
    let varianteBoa = null;
    const registro = [];
    const fimDaSequencia = async () => {
      const t = await sequencia.getEndTime();
      return t && t.seconds !== undefined ? t.seconds : 0;
    };
    for (let i = 0; i < trechos.length; i++) {
      const [ini, fim] = trechos[i];
      mostrar("Colocando trecho " + (i + 1) + " de " + trechos.length + "...");
      const tIni = await ppro.TickTime.createWithSeconds(ini);
      const tFim = await ppro.TickTime.createWithSeconds(fim);

      etapa = "definir entrada e saída do trecho " + (i + 1);
      await executar(projeto, "Autocut: entrada e saída",
        () => clip.createSetInOutPointsAction(tIni, tFim));

      if (i === 0) {
        etapa = "criar a sequência nova a partir do vídeo";
        sequencia = await projeto.createSequenceFromMedia("AUTOCUT TESTE", clip);
        await dormir(1000);
        editor = await ppro.SequenceEditor.getEditor(sequencia);
        try {
          const nV = await sequencia.getVideoTrackCount();
          const nA = await sequencia.getAudioTrackCount();
          const fimSeq = await sequencia.getEndTime();
          const seg = (fimSeq && fimSeq.seconds !== undefined) ? fimSeq.seconds : "?";
          diagnostico = "Trilhas de vídeo: " + nV + ", de áudio: " + nA +
            "\nDuração da sequência após o 1º trecho: " + seg + "s (esperado: " +
            (fim - ini).toFixed(2) + "s)";
        } catch (e) { diagnostico = "(não consegui ler os dados da sequência)"; }
      } else {
        etapa = "colocar o trecho " + (i + 1) + " na timeline";
        const duracao = fim - ini;
        // Variações do mesmo comando; a primeira que funcionar é reaproveitada.
        const variantes = [
          ["A) item original, fim real, sobrescrever 0/0", async () => {
            const t = await sequencia.getEndTime();
            return () => editor.createOverwriteItemAction(itemOriginal, t, 0, 0);
          }],
          ["B) item original, tempo calculado, sobrescrever 0/0", async () => {
            const t = await ppro.TickTime.createWithSeconds(posicao);
            return () => editor.createOverwriteItemAction(itemOriginal, t, 0, 0);
          }],
          ["C) item original, fim real, inserir 0/0", async () => {
            const t = await sequencia.getEndTime();
            return () => editor.createInsertProjectItemAction(itemOriginal, t, 0, 0, false);
          }],
          ["D) item original, fim real, sobrescrever 1/1", async () => {
            const t = await sequencia.getEndTime();
            return () => editor.createOverwriteItemAction(itemOriginal, t, 1, 1);
          }],
        ];
        const ordem = varianteBoa
          ? [varianteBoa, ...variantes.filter((v) => v[0] !== varianteBoa[0])]
          : variantes;
        let deuCerto = false;
        for (const v of ordem) {
          try {
            const antes = await fimDaSequencia();
            const criar = await v[1]();
            await executar(projeto, "Autocut: colocar trecho", criar);
            const depois = await fimDaSequencia();
            if (depois > antes + duracao * 0.5) {
              registro.push("Trecho " + (i + 1) + " - " + v[0] + ": OK");
              varianteBoa = v;
              deuCerto = true;
              break;
            }
            registro.push("Trecho " + (i + 1) + " - " + v[0] + ": sem efeito");
          } catch (e) {
            registro.push("Trecho " + (i + 1) + " - " + v[0] + ": erro (" + (e && e.message ? e.message : e) + ")");
          }
        }
        diagnostico = diagnostico.split("\n\nTentativas:")[0] + "\n\nTentativas:\n" + registro.join("\n");
        if (!deuCerto) throw new Error("Nenhuma variação funcionou para o trecho " + (i + 1) + ".");
      }

      posicao += fim - ini;
    }

    etapa = "limpar entrada e saída do clipe original";
    await executar(projeto, "Autocut: limpar entrada e saída",
      () => clip.createClearInOutPointsAction());

    mostrar("Pronto. Veja a sequência AUTOCUT TESTE no painel Projeto.\nTrechos colocados: " +
      trechos.map(([a, b]) => segundos(a) + "→" + segundos(b)).join("  |  ") +
      "\nDuração esperada: " + segundos(posicao) + "\n" + diagnostico);
  } catch (e) {
    mostrar("Erro ao " + etapa + ":\n" + (e && e.message ? e.message : e) +
      (diagnostico ? "\n" + diagnostico : ""), true);
  }
});

// --- Corte completo: todos os trechos numa sequência nova -------------------
// Depois do corte, recalcula os tempos do .srt para a sequência cortada.
const TRECHO_MINIMO = 0.3; // trechos de fala mais curtos que isso são ignorados

async function cortarTudo(caminho, prefixo) {
  let etapa = "começando";
  try {
    const ppro = require("premierepro");
    etapa = "abrir o projeto";
    const projeto = await ppro.Project.getActiveProject();

    etapa = "procurar o vídeo dentro do projeto";
    let achado = await acharClipe(ppro, projeto, caminho);
    if (!achado) {
      await projeto.importFiles([caminho]);
      await dormir(1500);
      achado = await acharClipe(ppro, projeto, caminho);
      if (!achado) {
        return mostrar("O vídeo não estava no projeto. Tentei importar, mas ainda não o encontrei. Confira o painel Projeto e clique de novo.", true);
      }
    }
    const clip = achado.clip;
    const itemOriginal = achado.item;

    etapa = "calcular os trechos de fala";
    mostrar("Analisando o áudio...");
    const r = await chamar("/silences", {
      path: caminho,
      noiseDb: lerNumero("limite", -31),
      minSilence: lerNumero("minimo", 0.5),
      padding: lerNumero("respiro", 0.25),
    });
    const trechos = r.keep.filter(([a, b]) => b - a >= TRECHO_MINIMO);
    if (!trechos.length) return mostrar("Não achei trechos de fala.", true);

    const hora = new Date();
    const nome = "AUTOCUT " + String(hora.getHours()).padStart(2, "0") +
      String(hora.getMinutes()).padStart(2, "0");
    let sequencia = null;
    let editor = null;
    const mapa = []; // onde cada trecho do original foi parar na sequência nova
    const fimDaSequencia = async () => {
      const t = await sequencia.getEndTime();
      return t && t.seconds !== undefined ? t.seconds : 0;
    };

    for (let i = 0; i < trechos.length; i++) {
      const [ini, fim] = trechos[i];
      mostrar("Cortando: trecho " + (i + 1) + " de " + trechos.length + "...\nNão mexa no Premiere até terminar.");
      const tIni = await ppro.TickTime.createWithSeconds(ini);
      const tFim = await ppro.TickTime.createWithSeconds(fim);

      etapa = "definir entrada e saída do trecho " + (i + 1);
      await executar(projeto, "Autocut: entrada e saída",
        () => clip.createSetInOutPointsAction(tIni, tFim));

      if (i === 0) {
        etapa = "criar a sequência nova";
        sequencia = await projeto.createSequenceFromMedia(nome, clip);
        await dormir(1000);
        editor = await ppro.SequenceEditor.getEditor(sequencia);
        mapa.push({ a: ini, b: fim, t: 0 });
      } else {
        etapa = "colocar o trecho " + (i + 1) + " na timeline";
        const antes = await fimDaSequencia();
        const tFimReal = await sequencia.getEndTime();
        await executar(projeto, "Autocut: colocar trecho",
          () => editor.createOverwriteItemAction(itemOriginal, tFimReal, 0, 0));
        const depois = await fimDaSequencia();
        if (depois < antes + (fim - ini) * 0.5) {
          throw new Error("o trecho " + (i + 1) + " não entrou na sequência");
        }
        mapa.push({ a: ini, b: fim, t: antes });
      }
    }

    etapa = "limpar entrada e saída do clipe original";
    await executar(projeto, "Autocut: limpar entrada e saída",
      () => clip.createClearInOutPointsAction());

    const duracaoFinal = await fimDaSequencia();
    let textoLegenda = "";
    etapa = "ajustar as legendas";
    try {
      // O nome do arquivo leva o nome da sequência, para ficar claro qual é qual.
      const l = await chamar("/remap", {
        path: caminho, segments: mapa, suffix: nome.replace(/\s+/g, ""),
      });
      const nomeArquivo = l.srt.split(/[\\/]/).pop();
      let importou = false;
      try {
        await projeto.importFiles([l.srt]);
        importou = true;
      } catch (e) { importou = false; }
      textoLegenda = "\n\nLegendas ajustadas (" + l.segments + "): " + nomeArquivo +
        (importou
          ? "\nJá está no painel Projeto: arraste para a timeline da sequência " + nome + "."
          : "\nNão consegui importar sozinho: arraste o arquivo da pasta do vídeo para a timeline.");
    } catch (e) {
      textoLegenda = "\n\nLegendas não ajustadas: " + e.message;
    }

    mostrar((prefixo ? prefixo + "\n" : "") +
      "Pronto. Sequência " + nome + " criada no painel Projeto.\n" +
      trechos.length + " trechos, " + segundos(duracaoFinal) + " (original: " + segundos(r.duration) + ")." +
      textoLegenda);
  } catch (e) {
    mostrar("Erro ao " + etapa + ":\n" + (e && e.message ? e.message : e), true);
  }
}

// Evita começar duas coisas ao mesmo tempo (o Premiere não gosta).
let ocupado = false;
async function semPressa(tarefa) {
  if (ocupado) return mostrar("Ainda estou trabalhando. Espere terminar.", true);
  ocupado = true;
  try { await tarefa(); } finally { ocupado = false; }
}

$("btnCortarTudo").addEventListener("click", () => semPressa(async () => {
  const caminho = await obterCaminho();
  if (!caminho) return;
  await cortarTudo(caminho, "");
}));

// Um clique: transcreve (se ainda não existir o .srt) e corta.
$("btnUmClique").addEventListener("click", () => semPressa(async () => {
  const caminho = await obterCaminho();
  if (!caminho) return;
  let relogio = null;
  let prefixo = "";
  try {
    const inicio = Date.now();
    const texto = () => {
      const s = Math.round((Date.now() - inicio) / 1000);
      return "Passo 1 de 2: transcrevendo a fala... " + Math.floor(s / 60) + " min " + (s % 60) +
        " s\nNa primeira vez o modelo é baixado, e isso demora.\nNão clique em nada até terminar.";
    };
    mostrar(texto());
    relogio = setInterval(() => mostrar(texto()), 1000);
    const t = await chamar("/transcribe", {
      path: caminho,
      model: $("modelo").value,
      device: $("dispositivo").value,
      language: "pt",
      reuse: true,
    });
    clearInterval(relogio);
    relogio = null;
    prefixo = t.reused
      ? "Legenda já existia (" + t.segments + " falas): transcrição pulada."
      : "Transcrição feita (" + t.segments + " falas).";
  } catch (e) {
    if (relogio) clearInterval(relogio);
    return mostrar("Erro ao transcrever:\n" + (e && e.message ? e.message : e), true);
  }
  await cortarTudo(caminho, prefixo);
}));

// --- Diagnóstico: como a sequência ativa está montada (só leitura) -----------
$("btnDiagnostico").addEventListener("click", async () => {
  try {
    const ppro = require("premierepro");
    const projeto = await ppro.Project.getActiveProject();
    const seq = await projeto.getActiveSequence();
    if (!seq) return mostrar("Nenhuma sequência ativa.", true);
    const seg = async (f) => {
      try { const t = await f(); return t && t.seconds !== undefined ? t.seconds.toFixed(2) : String(t); }
      catch (e) { return "?"; }
    };
    const linhas = ["Sequência: " + seq.name + " | duração " + (await seg(() => seq.getEndTime())) + "s"];
    const grupos = [
      ["V", await seq.getVideoTrackCount(), (i) => seq.getVideoTrack(i)],
      ["A", await seq.getAudioTrackCount(), (i) => seq.getAudioTrack(i)],
    ];
    for (const [prefixo, n, obter] of grupos) {
      for (let i = 0; i < n; i++) {
        const trilha = await obter(i);
        let itens = [];
        try { itens = await trilha.getTrackItems(1, false); }
        catch (e) { linhas.push(prefixo + (i + 1) + ": erro " + e.message); continue; }
        linhas.push(prefixo + (i + 1) + " (" + (trilha.name || "") + "): " + itens.length + " clipe(s)");
        for (const it of itens.slice(0, 3)) {
          let nome = "?", arquivo = "?";
          try {
            const pi = await it.getProjectItem();
            nome = pi.name;
            try {
              const c = await ppro.ClipProjectItem.cast(pi);
              arquivo = String(await c.getMediaFilePath()).split(/[\\/]/).pop();
            } catch (e) { /* sem caminho */ }
          } catch (e) { /* sem item */ }
          const ini = await seg(() => it.getStartTime());
          const fim = await seg(() => it.getEndTime());
          const fi = await seg(() => it.getInPoint());
          const fo = await seg(() => it.getOutPoint());
          let des = "?";
          try { des = (await it.isDisabled()) ? "SIM" : "não"; } catch (e) { /* sem leitura */ }
          linhas.push("   " + nome + " [" + arquivo + "] linha " + ini + "-" + fim + "s | fonte " + fi + "-" + fo + "s | desativado: " + des);
        }
      }
    }
    mostrar(linhas.join("\n"));
  } catch (e) {
    mostrar("Erro no diagnóstico:\n" + (e && e.message ? e.message : e), true);
  }
});

// --- Podcast (teste): quem fala + sincronia, sem mexer na timeline ---------
// Ajuste para o seu projeto: trilha de áudio (0 = A1) -> nome, canal do WAV, câmera.
let PODCAST_BASE_WAV = null; // 1ª trilha do arquivo multicanal dos microfones (descoberta na sequência)
// ---- Participantes e apresentadores: caixas que o usuário escreve e vai somando com "+" ----
const LINHAS = { ap: [], pt: [] };
const LIMITE = { ap: 4, pt: 8 };
const rotuloAudio = (i) => "A" + (i + 1);

function nomePadrao(grupo) {
  const usados = new Set(LINHAS[grupo].map((l) => l.nome.value.trim()));
  for (let k = 1; k < 50; k++) {
    const n = grupo === "ap" ? (k === 1 ? "Apresentador" : "Apresentador " + String(k).padStart(2, "0"))
                             : "Participante " + String(k).padStart(2, "0");
    if (!usados.has(n)) return n;
  }
  return grupo === "ap" ? "Apresentador" : "Participante";
}

function criarLinha(grupo, nome, cam, aud) {
  const lista = $(grupo === "ap" ? "listaApres" : "listaPart");
  if (!lista || LINHAS[grupo].length >= LIMITE[grupo]) return null;
  const linha = document.createElement("div");
  linha.className = "pessoa";
  const campo = document.createElement("input");
  campo.type = "text";
  campo.className = grupo === "ap" ? "cxAp" : "cxPt";
  campo.value = nome || nomePadrao(grupo);
  campo.addEventListener("focus", () => { try { campo.select(); } catch (e) { /* segue */ } });
  const sc = document.createElement("select");
  for (const v of ["V1", "V2", "V3", "V4"]) { const o = document.createElement("option"); o.value = v; o.textContent = v; sc.appendChild(o); }
  const sa = document.createElement("select");
  for (let i = 0; i < 12; i++) { const o = document.createElement("option"); o.value = String(i); o.textContent = rotuloAudio(i); sa.appendChild(o); }
  const usadas = LINHAS.ap.concat(LINHAS.pt).map((l) => parseInt(l.aud.value, 10));
  sc.value = cam || (grupo === "ap" ? "V2" : "V3");
  sa.value = String(aud !== undefined ? aud : Math.min(11, usadas.length ? Math.max(...usadas) + 1 : 3));
  const obj = { grupo, linha, nome: campo, cam: sc, aud: sa };
  linha.appendChild(campo); linha.appendChild(sc); linha.appendChild(sa);
  const x = document.createElement("div");
  x.className = "tirar"; x.textContent = "×";
  if (LINHAS[grupo].length === 0) { // a primeira de cada grupo fica fixa: só um espaço para alinhar
    x.style.opacity = "0";
    linha.appendChild(x);
  } else { // as outras podem ser removidas
    x.addEventListener("click", () => { lista.removeChild(linha); LINHAS[grupo] = LINHAS[grupo].filter((l) => l !== obj); });
    linha.appendChild(x);
  }
  lista.appendChild(linha);
  LINHAS[grupo].push(obj);
  return obj;
}

// lê as caixas: devolve { pessoas, apresentadores } (nomes sem repetição; nome em branco = ignorada)
function lerPessoas() {
  const vistos = new Set(), pessoas = [], apresentadores = [];
  for (const g of ["ap", "pt"]) {
    for (const l of LINHAS[g]) {
      let nome = l.nome.value.trim();
      if (!nome) continue;
      let base = nome, k = 2;
      while (vistos.has(nome)) nome = base + " " + k++;
      vistos.add(nome);
      pessoas.push({ nome, trilhaAudio: parseInt(l.aud.value, 10) || 0, camera: l.cam.value });
      if (g === "ap") apresentadores.push(nome);
    }
  }
  return { pessoas, apresentadores };
}

const PODCAST = {
  get pessoas() {
    const { pessoas } = lerPessoas();
    if (!pessoas.length) throw new Error("Escreva o nome de pelo menos uma pessoa em \"Participantes e apresentador\" (aba Podcast).");
    const base = PODCAST_BASE_WAV !== null ? PODCAST_BASE_WAV : Math.min(...pessoas.map((p) => p.trilhaAudio));
    return pessoas.map((p) => ({ ...p, canal: Math.max(0, p.trilhaAudio - base) }));
  },
  get geral() { return $("pGeral") ? $("pGeral").value : "V1"; },
  get apresentadores() { return lerPessoas().apresentadores; },
  get prioridade() { return $("pPrior") ? parseInt($("pPrior").value, 10) || 0 : 0; },
  cortarSilencios: false, // neste material: só troca de câmera, nada é removido
};

(function () {
  if (!$("menuPartic")) return;
  criarLinha("ap", "Apresentador", "V2", 6); // valores iniciais (projeto do Danilo)
  criarLinha("pt", "Participante 01", "V3", 3);
  if ($("pGeral")) $("pGeral").value = "V1";
  $("btnMaisApres").addEventListener("click", () => criarLinha("ap"));
  $("btnMaisPart").addEventListener("click", () => criarLinha("pt"));
  $("menuPartic").addEventListener("click", () => {
    const aberto = $("corpoPartic").style.display !== "none";
    $("corpoPartic").style.display = aberto ? "none" : "block";
    $("setaPartic").textContent = aberto ? "▸" : "▾";
  });
})();

// Câmeras realmente usadas (as dos participantes + a geral), em ordem: ["V1","V3"...]
function camerasUsadas() {
  const s = new Set(PODCAST.pessoas.map((p) => p.camera));
  s.add(PODCAST.geral);
  return Array.from(s).sort();
}

// Confere se a sequência ativa tem as trilhas escolhidas, descobre onde começa o áudio
// multicanal dos microfones e devolve o caminho desse arquivo.
async function wavDoPodcast(ppro, sequencia) {
  const pessoas = PODCAST.pessoas;
  const nV = await sequencia.getVideoTrackCount();
  const nA = await sequencia.getAudioTrackCount();
  const faltam = [];
  for (const v of camerasUsadas()) if (parseInt(v.slice(1), 10) > nV) faltam.push(v);
  for (const p of pessoas) if (p.trilhaAudio + 1 > nA) faltam.push("A" + (p.trilhaAudio + 1));
  if (faltam.length) {
    throw new Error("Esta sequência não tem as trilhas: " + Array.from(new Set(faltam)).join(", ") +
      ".\nAbra a sequência do podcast (câmeras no vídeo e microfones no áudio) ou ajuste os números " +
      "em \"Participantes e apresentador\" para ficarem iguais aos da sua timeline.");
  }
  const wav = await caminhoDaTrilha(ppro, sequencia, "A", pessoas[0].trilhaAudio);
  let base = pessoas[0].trilhaAudio;
  for (let i = 0; i < nA; i++) {
    try {
      if ((await caminhoDaTrilha(ppro, sequencia, "A", i)) === wav) { base = i; break; }
    } catch (e) { /* trilha vazia: segue */ }
  }
  PODCAST_BASE_WAV = base;
  return wav;
}

async function caminhoDaTrilha(ppro, sequencia, tipo, indice) {
  const trilha = tipo === "V" ? await sequencia.getVideoTrack(indice) : await sequencia.getAudioTrack(indice);
  const itens = await trilha.getTrackItems(1, false);
  if (!itens.length) throw new Error("Trilha " + tipo + (indice + 1) + " vazia");
  const pi = await itens[0].getProjectItem();
  const clip = await ppro.ClipProjectItem.cast(pi);
  return await clip.getMediaFilePath();
}

$("btnPodcast").addEventListener("click", () => semPressa(async () => {
  try {
    const ppro = require("premierepro");
    const projeto = await ppro.Project.getActiveProject();
    const sequencia = await projeto.getActiveSequence();
    if (!sequencia) return mostrar("Nenhuma sequência ativa.", true);

    mostrar("Lendo os arquivos da sequência...");
    const wav = await wavDoPodcast(ppro, sequencia);
    const cams = [];
    for (const v of camerasUsadas()) cams.push(await caminhoDaTrilha(ppro, sequencia, "V", parseInt(v.slice(1), 10) - 1));

    mostrar("1/2 Conferindo a sincronia (câmeras x áudio dos microfones)...\n(pode levar uns 20 segundos)");
    const sync = await chamar("/sync", { path: wav, outros: cams });
    const linhasSync = sync.resultados.map((r, i) =>
      "V" + (i + 1) + ": " + r.deslocamento.toFixed(3) + " s (confiança " + r.confianca.toFixed(1) + ")");

    mostrar("2/2 Detectando quem fala...\n(pode levar uns 30 segundos)");
    const fala = await chamar("/speakers", {
      path: wav,
      pessoas: PODCAST.pessoas.map((p) => ({ nome: p.nome, canal: p.canal, camera: p.camera })),
    });
    const tempos = Object.keys(fala.tempo).map((k) => k + ": " + Math.round(fala.tempo[k]) + " s").join(" | ");
    const amostra = fala.trechos.slice(0, 12).map((t) =>
      t.ini.toFixed(1) + "-" + t.fim.toFixed(1) + " " + t.quem + " -> " + (t.camera || PODCAST.geral)).join("\n");

    mostrar("Sincronia (atraso de cada câmera em relação ao áudio dos microfones; perto de 0 = ok):\n" +
      linhasSync.join("\n") + "\n\nTempo falado:\n" + tempos +
      "\n\nTrechos de câmera: " + fala.trechos.length + "\nPrimeiros:\n" + amostra);
  } catch (e) {
    mostrar("Erro na análise do podcast:\n" + (e && e.message ? e.message : e), true);
  }
}));

// --- Podcast: monta a sequência (câmeras sincronizadas + cortes) -------------
// limite = até quantos segundos da sequência nova montar (Infinity = tudo).
async function montarPodcast(limite, opcoes = {}) {
  let etapa = "começando";
  try {
    const ppro = require("premierepro");
    const projeto = await ppro.Project.getActiveProject();
    const origem = await projeto.getActiveSequence();
    if (!origem) return mostrar("Nenhuma sequência ativa.", true);

    etapa = "ler os arquivos da sequência";
    const wav = await wavDoPodcast(ppro, origem);
    const cameras = {};
    for (const v of camerasUsadas()) cameras[v] = await caminhoDaTrilha(ppro, origem, "V", parseInt(v.slice(1), 10) - 1);

    etapa = "calcular o plano de cortes";
    mostrar("Calculando sincronia e cortes...\n(uns 40 segundos; não mexa no Premiere)");
    const plano = await chamar("/plano_podcast", {
      path: wav, cameras,
      pessoas: PODCAST.pessoas.map((p) => ({ nome: p.nome, canal: p.canal, camera: p.camera })),
      geral: PODCAST.geral, apresentadores: PODCAST.apresentadores, prioridade: PODCAST.prioridade,
      minimo: lerNumero("minimo"), respiro: lerNumero("respiro"),
      cortarSilencios: PODCAST.cortarSilencios,
      faixas: opcoes.faixas || null,
    });
    const pecas = plano.pecas.filter((p) => p.t < limite);
    const keeps = plano.keeps.filter((k) => k.t < limite);
    if (!pecas.length) return mostrar("O plano não gerou nenhum trecho.", true);

    etapa = "achar os arquivos no projeto";
    const itens = {};
    for (const [nome, caminho] of Object.entries({ ...cameras, WAV: wav })) {
      let achado = await acharClipe(ppro, projeto, caminho);
      if (!achado) {
        await projeto.importFiles([caminho]);
        await dormir(1500);
        achado = await acharClipe(ppro, projeto, caminho);
      }
      if (!achado) throw new Error("não achei " + nome + " no projeto");
      itens[nome] = achado;
    }

    const hora = new Date();
    const nome = (opcoes.prefixo || "PODCAST ") + String(hora.getHours()).padStart(2, "0") + String(hora.getMinutes()).padStart(2, "0");
    let sequencia = null, editor = null;
    const fimSeq = async () => { const t = await sequencia.getEndTime(); return t && t.seconds !== undefined ? t.seconds : 0; };
    const usados = new Set();
    const avisos = [];
    const camerasOrdem = Object.keys(cameras); // V1, V2, V3

    // 1) vídeo: cada câmera fica INTEIRA na sua própria trilha (V1, V2, V3), cortada
    // nos mesmos pontos. Onde ela é a escolhida o pedaço fica ativo; nos demais fica
    // DESATIVADO (nada é apagado: dá para reativar qualquer pedaço depois).
    const corridas = {};
    for (const cam of camerasOrdem) {
      const lista = [];
      for (const p of pecas) {
        const ativo = p.camera === cam;
        const ult = lista[lista.length - 1];
        if (ult && !ativo && !ult.ativo && Math.abs(ult.b - p.a) < 1e-6) ult.b = p.b;
        else lista.push({ t: p.t, a: p.a, b: p.b, ativo });
      }
      corridas[cam] = lista;
    }
    const totalPecas = camerasOrdem.reduce((s, c) => s + corridas[c].length, 0);
    let feitas = 0;
    for (let ci = 0; ci < camerasOrdem.length; ci++) {
      const cam = camerasOrdem[ci];
      const alvo = itens[cam];
      const atraso = plano.atraso[cam].valor;
      const lista = corridas[cam];
      for (let i = 0; i < lista.length; i++) {
        const r = lista[i];
        feitas++;
        mostrar("Montando vídeo (" + cam + "): peça " + feitas + " de " + totalPecas + "\nNão mexa no Premiere.");
        etapa = "definir entrada/saída da peça " + feitas + " (" + cam + ")";
        const tIni = await ppro.TickTime.createWithSeconds(r.a + atraso);
        const tFim = await ppro.TickTime.createWithSeconds(r.b + atraso);
        await executar(projeto, "Podcast: entrada e saída", () => alvo.clip.createSetInOutPointsAction(tIni, tFim));
        usados.add(cam);
        if (!sequencia) {
          etapa = "criar a sequência nova";
          sequencia = await projeto.createSequenceFromMedia(nome, alvo.clip);
          await dormir(1000);
          editor = await ppro.SequenceEditor.getEditor(sequencia);
        } else {
          etapa = "colocar a peça " + feitas + " (" + cam + ") na timeline";
          let t;
          if (ci === 0) t = await sequencia.getEndTime();
          else t = await ppro.TickTime.createWithSeconds(r.t);
          // trilha de vídeo ci e trilha de áudio ci (o áudio da câmera vai junto)
          await executar(projeto, "Podcast: colocar peça", () => editor.createOverwriteItemAction(alvo.item, t, ci, ci));
        }
      }
      // confere as trilhas e desativa os pedaços em que esta câmera não é a escolhida
      etapa = "desativar os pedaços não usados de " + cam;
      const nV = await sequencia.getVideoTrackCount();
      if (nV <= ci) { avisos.push(cam + ": a trilha V" + (ci + 1) + " não foi criada"); continue; }
      const q = await (await sequencia.getVideoTrack(ci)).getTrackItems(1, false);
      if (q.length !== lista.length) avisos.push(cam + ": esperava " + lista.length + " pedaços, achei " + q.length);
      let desvio = 0;
      const alvos = [];
      for (let i = 0; i < Math.min(q.length, lista.length); i++) {
        try {
          const s = await q[i].getStartTime();
          desvio = Math.max(desvio, Math.abs(s.seconds - lista[i].t));
        } catch (e) { /* sem leitura */ }
        if (!lista[i].ativo) alvos.push(q[i]);
      }
      if (desvio > 0.1) avisos.push(cam + ": posição fora do esperado em até " + desvio.toFixed(2) + " s");
      for (let k = 0; k < alvos.length; k += 25) {
        const lote = alvos.slice(k, k + 25);
        projeto.lockedAccess(() => {
          projeto.executeTransaction((composto) => {
            for (const it of lote) composto.addAction(it.createSetDisabledAction(true));
          }, "Podcast: desativar pedaços");
        });
        await dormir(500);
      }
    }

    // 2) áudio dos microfones (WAV), contínuo por baixo dos cortes de câmera.
    // Fica depois das trilhas de áudio das câmeras (A1..A3): Canal 1 = A4, Canal 2 = A5...
    const primeiraTrilhaWav = camerasOrdem.length;
    for (let i = 0; i < keeps.length; i++) {
      const k = keeps[i];
      mostrar("Montando áudio: trecho " + (i + 1) + " de " + keeps.length + "\nNão mexa no Premiere.");
      etapa = "colocar o áudio do trecho " + (i + 1);
      const tIni = await ppro.TickTime.createWithSeconds(k.a);
      const tFim = await ppro.TickTime.createWithSeconds(k.b);
      await executar(projeto, "Podcast: entrada e saída (áudio)", () => itens.WAV.clip.createSetInOutPointsAction(tIni, tFim));
      const tPos = await ppro.TickTime.createWithSeconds(k.t);
      await executar(projeto, "Podcast: colocar áudio", () => editor.createOverwriteItemAction(itens.WAV.item, tPos, 0, primeiraTrilhaWav));
    }

    etapa = "limpar entradas e saídas";
    for (const c of usados) await executar(projeto, "Podcast: limpar", () => itens[c].clip.createClearInOutPointsAction());
    await executar(projeto, "Podcast: limpar", () => itens.WAV.clip.createClearInOutPointsAction());

    // silencia o que não é microfone de pessoa: áudio ambiente das câmeras (A1..A3) e
    // canais sem uso do gravador. Nada é apagado: basta desmarcar o "M" para ouvir.
    etapa = "silenciar as trilhas que não são microfones";
    let silenciadas = 0, falhaMute = "";
    try {
      const vivos = new Set(PODCAST.pessoas.map((p) => primeiraTrilhaWav + p.canal));
      const total = await sequencia.getAudioTrackCount();
      for (let i = 0; i < total; i++) {
        if (vivos.has(i)) continue;
        const tr = await sequencia.getAudioTrack(i);
        await tr.setMute(true);
        silenciadas++;
      }
    } catch (e) { falhaMute = " (não consegui silenciar: " + (e && e.message ? e.message : e) + ")"; }

    // resumo do que ficou na sequência
    const linhas = [];
    const nV = await sequencia.getVideoTrackCount();
    const nA = await sequencia.getAudioTrackCount();
    for (let i = 0; i < nV; i++) { const q = await (await sequencia.getVideoTrack(i)).getTrackItems(1, false); linhas.push("V" + (i + 1) + ": " + q.length + " clipe(s)"); }
    for (let i = 0; i < nA; i++) { const q = await (await sequencia.getAudioTrack(i)).getTrackItems(1, false); linhas.push("A" + (i + 1) + ": " + q.length + " clipe(s)"); }
    const atrasos = Object.entries(plano.atraso).map(([c, v]) => c + " " + v.valor.toFixed(3) + "s").join(" | ");
    mostrar("Pronto. Sequência " + nome + " criada (veja no painel Projeto).\n" +
      totalPecas + " peças de vídeo (3 câmeras), " + keeps.length + " trecho(s) de áudio, " + (await fimSeq()).toFixed(1) + " s (áudio original: " + plano.duracao.toFixed(1) + " s; com imagem em todas as câmeras de " + plano.faixaComImagem[0].toFixed(1) + " a " + plano.faixaComImagem[1].toFixed(1) + " s).\n" +
      "Atraso das câmeras: " + atrasos + "\nTrilhas silenciadas: " + silenciadas + falhaMute +
      (avisos.length ? "\nAVISOS:\n- " + avisos.join("\n- ") : "\nSem avisos.") + "\n" + linhas.join("\n"));
  } catch (e) {
    mostrar("Erro ao " + etapa + ":\n" + (e && e.message ? e.message : e), true);
  }
}

$("btnPodcastTeste").addEventListener("click", () => semPressa(() => montarPodcast(25)));
$("btnPodcastTudo").addEventListener("click", () => semPressa(() => montarPodcast(Infinity)));

// --- Legendas do podcast: transcrição por palavra (só os microfones) ---------
$("btnLegendasPodcast").addEventListener("click", () => semPressa(async () => {
  let relogio = null;
  try {
    const ppro = require("premierepro");
    const projeto = await ppro.Project.getActiveProject();
    const sequencia = await projeto.getActiveSequence();
    if (!sequencia) return mostrar("Nenhuma sequência ativa.", true);
    const wav = await wavDoPodcast(ppro, sequencia);

    const inicio = Date.now();
    const texto = "Transcrevendo as falas (microfones de " + PODCAST.pessoas.map((p) => p.nome).join(", ") +
      ").\nNa primeira vez leva uns 25 minutos neste computador; depois fica guardado e é rápido.\nNão feche o Premiere.";
    relogio = setInterval(() => {
      const s = Math.round((Date.now() - inicio) / 1000);
      mostrar(texto + "\nTempo decorrido: " + Math.floor(s / 60) + " min " + (s % 60) + " s");
    }, 1000);

    const r = await chamar("/legendas_podcast", {
      path: wav,
      pessoas: PODCAST.pessoas.map((p) => ({ nome: p.nome, canal: p.canal, camera: p.camera })),
      model: $("modelo").value, device: $("dispositivo").value, language: "pt", reuse: true,
    });
    clearInterval(relogio); relogio = null;

    let importou = false;
    try { await projeto.importFiles([r.padrao, r.curtas]); importou = true; } catch (e) { importou = false; }
    const nomeDe = (c) => c.split(/[\\/]/).pop();
    mostrar("Pronto" + (r.reaproveitou ? " (usei a transcrição já guardada)" : "") + ".\n" +
      r.palavras + " palavras reconhecidas.\n\n" +
      "1) " + nomeDe(r.padrao) + " (" + r.legendasPadrao + " legendas, frases em uma linha)\n" +
      "2) " + nomeDe(r.curtas) + " (" + r.legendasCurtas + " legendas, 1 a 2 palavras por vez)\n\n" +
      (importou ? "Os dois já estão no painel Projeto. " : "Não consegui importar sozinho; estão na pasta do áudio. ") +
      "Arraste o que quiser para a timeline da sequência PODCAST.");
  } catch (e) {
    mostrar("Erro nas legendas do podcast:\n" + (e && e.message ? e.message : e), true);
  } finally {
    if (relogio) clearInterval(relogio);
  }
}));

// --- Teste: inserir um template de texto (.mogrt) e ler seus controles -------
// Trabalha numa sequência de RASCUNHO nova; não mexe na sua sequência.
const MOGRT_TESTE = "C:\\Users\\Danilo\\AppData\\Roaming\\Adobe\\Common\\Motion Graphics Templates\\AutoCut Teste.mogrt";

function nomesDe(o) {
  const r = new Set();
  let p = o;
  for (let i = 0; p && i < 4; i++) { Object.getOwnPropertyNames(p).forEach((n) => r.add(n)); p = Object.getPrototypeOf(p); }
  return Array.from(r).filter((n) => !/^(constructor|__|has|is(Proto|Prop)|property|toLocale|toString|valueOf)/.test(n)).sort();
}

$("btnMogrtTeste").addEventListener("click", () => semPressa(async () => {
  const L = [];
  let etapa = "começando";
  try {
    const ppro = require("premierepro");
    const projeto = await ppro.Project.getActiveProject();
    const origem = await projeto.getActiveSequence();
    etapa = "achar um vídeo para a sequência de rascunho";
    const caminho = await caminhoDaTrilha(ppro, origem, "V", 0);
    const achado = await acharClipe(ppro, projeto, caminho);
    if (!achado) throw new Error("vídeo não está no projeto");
    const t0 = await ppro.TickTime.createWithSeconds(0);
    const t1 = await ppro.TickTime.createWithSeconds(30);
    await executar(projeto, "Teste: entrada e saída", () => achado.clip.createSetInOutPointsAction(t0, t1));
    etapa = "criar a sequência de rascunho";
    const seq = await projeto.createSequenceFromMedia("TESTE TEMPLATE", achado.clip);
    await dormir(1000);
    await executar(projeto, "Teste: limpar", () => achado.clip.createClearInOutPointsAction());
    const editor = await ppro.SequenceEditor.getEditor(seq);

    etapa = "inserir o template";
    const tPos = await ppro.TickTime.createWithSeconds(2);
    let r;
    try {
      r = await editor.insertMogrtFromPath(MOGRT_TESTE, tPos, 2, 2);
      L.push("insertMogrtFromPath respondeu: " + (Array.isArray(r) ? "lista de " + r.length : typeof r));
    } catch (e) { L.push("insertMogrtFromPath ERRO: " + (e && e.message ? e.message : e)); }
    await dormir(1500);

    etapa = "ler o clipe inserido";
    const nV = await seq.getVideoTrackCount();
    L.push("Trilhas de vídeo: " + nV);
    let alvo = null;
    for (let i = 0; i < nV; i++) {
      const q = await (await seq.getVideoTrack(i)).getTrackItems(1, false);
      L.push("V" + (i + 1) + ": " + q.length + " clipe(s)");
      if (i === 2 && q.length) alvo = q[0];
    }
    if (!alvo) throw new Error("o template não apareceu em V3");

    etapa = "ler os controles do template";
    L.push("Métodos do clipe: " + nomesDe(alvo).join(", "));
    const cadeia = await alvo.getComponentChain();
    L.push("Métodos da cadeia: " + nomesDe(cadeia).join(", "));
    const n = await cadeia.getComponentCount();
    L.push("Componentes: " + n);
    for (let i = 0; i < n; i++) {
      const comp = await cadeia.getComponentAtIndex(i);
      if (i === 0) L.push("Métodos do componente: " + nomesDe(comp).join(", "));
      let nome = "?";
      try { nome = await comp.getDisplayName(); } catch (e) { try { nome = await comp.getMatchName(); } catch (e2) { /* sem nome */ } }
      let np = "?";
      try { np = await comp.getParamCount(); } catch (e) { /* sem contagem */ }
      L.push("- componente " + i + ": " + nome + " | parâmetros: " + np);
      if (typeof np === "number") {
        for (let j = 0; j < Math.min(np, 12); j++) {
          try {
            const p = await comp.getParam(j);
            if (i === 0 && j === 0) L.push("Métodos do parâmetro: " + nomesDe(p).join(", "));
            let pn = p.displayName || p.name || "?";
            let v = "?";
            try { v = await p.getValue(); } catch (e) { /* sem valor */ }
            L.push("    · " + pn + " = " + (typeof v === "object" ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 60)));
          } catch (e) { L.push("    · parâmetro " + j + ": erro " + (e && e.message ? e.message : e)); }
        }
      }
    }
    mostrar(L.join("\n"));
  } catch (e) {
    mostrar("Erro ao " + etapa + ":\n" + (e && e.message ? e.message : e) + "\n\n" + L.join("\n"), true);
  }
}));

// --- Legendas estilizadas: funciona em QUALQUER sequência ---------------------------
// Acha o áudio da fala (qualquer trilha), transcreve só o trecho pedido e coloca os
// templates numa trilha de vídeo livre (acima de tudo), sem mexer no resto da timeline.
$("btnEstilizadas").addEventListener("click", () => semPressa(async () => {
  let etapa = "começando";
  const lerTempo = (txt, padrao) => {
    const t = String(txt || "").trim().replace(",", ".");
    if (!t) return padrao;
    const p = t.split(":").map(Number);
    if (p.some((x) => !isFinite(x))) return NaN;
    return p.length === 1 ? p[0] : p.length === 2 ? p[0] * 60 + p[1] : p[0] * 3600 + p[1] * 60 + p[2];
  };
  const sec = async (f) => { const t = await f(); return t && t.seconds !== undefined ? t.seconds : Number(t); };
  const ESTILO = ($("estEstilo") && $("estEstilo").value) || "aleatorio";
  const ESCOLHA_AUDIO = ($("estAudio") && $("estAudio").value) || "auto";
  try {
    const ppro = require("premierepro");
    const projeto = await ppro.Project.getActiveProject();
    const seq = await projeto.getActiveSequence();
    if (!seq) return mostrar("Nenhuma sequência ativa. Clique na sequência na timeline.", true);
    const fimSeq = await sec(() => seq.getEndTime());
    if (!(fimSeq > 0)) return mostrar("A sequência está vazia.", true);
    const INICIO = lerTempo($("estInicio") && $("estInicio").value, 0);
    const FIM = Math.min(lerTempo($("estFim") && $("estFim").value, INICIO + 180), fimSeq);
    if (!(FIM > INICIO) || !(INICIO >= 0)) return mostrar("Confira Início e Fim (exemplo: 0:00 e 1:00). O Fim precisa ser maior que o Início e caber na sequência (ela tem " + Math.floor(fimSeq / 60) + ":" + String(Math.floor(fimSeq % 60)).padStart(2, "0") + ").", true);
    if (FIM - INICIO > 180) return mostrar("Escolha um trecho de até 3 minutos por vez.", true);

    // ---- quais trilhas têm clipes (para achar o áudio da fala e uma trilha de vídeo livre)
    etapa = "ler as trilhas da sequência";
    const nV = await seq.getVideoTrackCount();
    const nA = await seq.getAudioTrackCount();
    const lerTrilha = async (tipo, i) => {
      const tr = tipo === "V" ? await seq.getVideoTrack(i) : await seq.getAudioTrack(i);
      const itens = await tr.getTrackItems(1, false);
      const lista = [];
      for (const it of itens) {
        let des = false;
        try { des = !!(await it.isDisabled()); } catch (e) { des = false; }
        lista.push({ it, ini: await sec(() => it.getStartTime()), fim: await sec(() => it.getEndTime()), des });
      }
      return lista;
    };
    const sobrepoe = (c) => c.fim > INICIO + 0.05 && c.ini < FIM - 0.05;

    const audio = [];
    for (let i = 0; i < nA; i++) audio.push(await lerTrilha("A", i));
    const video = [];
    for (let i = 0; i < nV; i++) video.push(await lerTrilha("V", i));

    // trilha de áudio da fala
    let ia = -1;
    if (ESCOLHA_AUDIO !== "auto") ia = parseInt(ESCOLHA_AUDIO, 10);
    else for (let i = 0; i < nA; i++) if (audio[i].some((c) => !c.des && sobrepoe(c))) { ia = i; break; }
    if (ia < 0 || ia >= nA || !audio[ia].some((c) => !c.des && sobrepoe(c))) {
      return mostrar("Não achei áudio de fala nesse trecho" + (ESCOLHA_AUDIO !== "auto" ? " na trilha A" + (ia + 1) : "") +
        ".\nConfira Início/Fim e a trilha de áudio da fala.", true);
    }
    const clipesFala = audio[ia].filter((c) => !c.des && sobrepoe(c));

    // trilha de vídeo livre (a mais alta sem nenhum clipe no trecho), nunca a V1
    let iv = -1;
    for (let i = nV - 1; i >= 1; i--) if (!video[i].some(sobrepoe)) { iv = i; break; }
    if (iv < 0) {
      return mostrar("Não há uma trilha de vídeo livre para as legendas nesse trecho.\nAdicione uma trilha de vídeo vazia (botão direito no nome das trilhas > Adicionar trilha) e tente de novo.", true);
    }

    // ---- transcreve e gera os templates, clipe por clipe
    const todas = [];
    let k = 0;
    for (const c of clipesFala) {
      k++;
      etapa = "ler o arquivo do clipe " + k;
      const pi = await c.it.getProjectItem();
      const cl = await ppro.ClipProjectItem.cast(pi);
      const arquivo = await cl.getMediaFilePath();
      if (!arquivo) throw new Error("o clipe " + k + " não tem arquivo de origem");
      const noClipe = await sec(() => c.it.getInPoint()); // ponto de entrada na fonte
      const a = Math.max(c.ini, INICIO), b = Math.min(c.fim, FIM);
      const fonteA = noClipe + (a - c.ini), fonteB = noClipe + (b - c.ini);

      etapa = "transcrever a fala (clipe " + k + " de " + clipesFala.length + ")";
      const inicioT = Date.now();
      const relogio = setInterval(() => {
        const s = Math.round((Date.now() - inicioT) / 1000);
        mostrar("Transcrevendo a fala (clipe " + k + " de " + clipesFala.length + ", áudio da trilha A" + (ia + 1) + ")...\n" +
          "Na primeira vez pode levar alguns minutos. Não feche o Premiere.\nTempo: " + Math.floor(s / 60) + " min " + (s % 60) + " s");
      }, 1000);
      let t;
      try {
        t = await chamar("/palavras_trecho", {
          path: arquivo, inicio: fonteA, fim: fonteB,
          model: $("modelo").value, device: $("dispositivo").value, language: "pt",
        });
      } finally { clearInterval(relogio); }
      if (!t.palavras) continue; // sem fala neste pedaço

      etapa = "gerar os templates de legenda (clipe " + k + ")";
      mostrar("Gerando os templates das legendas (clipe " + k + " de " + clipesFala.length + ")...");
      let r;
      try {
        r = await chamar("/legendas_estilizadas", {
          path: arquivo, cache: t.cache, inicio: fonteA, fim: fonteB, modo: "blocos",
          estilo: ESTILO, enxuto: true, semente: 7, prefixo: "c" + k + "_",
        });
      } catch (e) {
        if (/Não há falas/.test(String(e && e.message))) continue;
        throw e;
      }
      for (const l of r.legendas) {
        const ini = c.ini + (l.ini - noClipe);
        const fim = Math.min(c.ini + (l.fim - noClipe), c.fim);
        if (ini >= INICIO - 0.01 && ini < FIM) todas.push({ ...l, seqIni: ini, seqFim: fim });
      }
    }
    if (!todas.length) return mostrar("Não encontrei falas nesse trecho. Confira Início/Fim e a trilha de áudio.", true);
    todas.sort((x, y) => x.seqIni - y.seqIni);

    // ---- coloca na trilha livre
    etapa = "inserir as legendas";
    const editor = await ppro.SequenceEditor.getEditor(seq);
    const falhas = [];
    const inserir = async (l) => {
      const tIni = await ppro.TickTime.createWithSeconds(l.seqIni);
      let ultimo = "";
      for (let tentativa = 1; tentativa <= 3; tentativa++) {
        try {
          const itens = await editor.insertMogrtFromPath(l.arquivo, tIni, iv, 0);
          if (!itens || !itens.length) throw new Error("o Premiere não devolveu o clipe");
          return "";
        } catch (e) {
          ultimo = e && e.message ? e.message : String(e);
          await dormir(2000);
        }
      }
      return ultimo;
    };
    for (let i = 0; i < todas.length; i++) {
      const l = todas[i];
      mostrar("Colocando legenda " + (i + 1) + " de " + todas.length + " (" + l.estilo + ") na trilha V" + (iv + 1) + ":\n" + l.texto);
      etapa = "inserir a legenda " + (i + 1);
      const erro = await inserir(l);
      if (erro) falhas.push("legenda " + (i + 1) + " \"" + l.texto + "\": " + erro);
      await dormir(1000);
    }
    await dormir(3000);

    // confere o que ficou e recoloca o que sumiu (até 5 rodadas)
    let recolocadas = 0;
    const faltando = async () => {
      const lista = await (await seq.getVideoTrack(iv)).getTrackItems(1, false);
      const ini = [];
      for (const c of lista) ini.push(await sec(() => c.getStartTime()));
      return todas.filter((l) => !ini.some((x) => Math.abs(x - l.seqIni) < 0.06));
    };
    for (let rodada = 1; rodada <= 5; rodada++) {
      etapa = "conferir as legendas (rodada " + rodada + ")";
      const falta = await faltando();
      if (!falta.length) break;
      mostrar("Rodada " + rodada + ": recolocando " + falta.length + " legenda(s) que sumiram...");
      for (const l of falta) { await inserir(l); recolocadas++; await dormir(1200); }
      await dormir(3000);
    }
    const finais = await (await seq.getVideoTrack(iv)).getTrackItems(1, false);
    mostrar("Pronto! " + finais.length + " legendas na trilha V" + (iv + 1) + " da sequência " + seq.name + ".\n" +
      "Fala lida da trilha A" + (ia + 1) + ", de " + Math.floor(INICIO / 60) + ":" + String(Math.floor(INICIO % 60)).padStart(2, "0") +
      " a " + Math.floor(FIM / 60) + ":" + String(Math.floor(FIM % 60)).padStart(2, "0") + ".\n" +
      "Estilos: " + Array.from(new Set(todas.map((l) => l.estilo))).join(", ") +
      (recolocadas ? "\nRecolocadas: " + recolocadas : "") +
      (falhas.length ? "\nFALHAS:\n- " + falhas.join("\n- ") : "\nSem falhas.") +
      "\n(Para desfazer: Ctrl+Z, ou apague os clipes dessa trilha.)");
  } catch (e) {
    mostrar("Erro ao " + etapa + ":\n" + (e && e.message ? e.message : e), true);
  }
}));

// --- Lista todos os clipes de uma trilha de vídeo (V3) da sequência ativa ----
$("btnListaV3").addEventListener("click", async () => {
  try {
    const ppro = require("premierepro");
    const projeto = await ppro.Project.getActiveProject();
    const seq = await projeto.getActiveSequence();
    const q = await (await seq.getVideoTrack(2)).getTrackItems(1, false);
    const linhas = ["Sequência " + seq.name + " | V3: " + q.length + " clipe(s)"];
    for (let i = 0; i < q.length; i++) {
      const s = await q[i].getStartTime(), e = await q[i].getEndTime();
      let nome = "?";
      try { nome = await q[i].getName(); } catch (x) { /* sem nome */ }
      linhas.push((i + 1) + ": " + s.seconds.toFixed(2) + " → " + e.seconds.toFixed(2) + " (" + (e.seconds - s.seconds).toFixed(2) + " s) " + nome);
    }
    mostrar(linhas.join("\n"));
  } catch (e) {
    mostrar("Erro:\n" + (e && e.message ? e.message : e), true);
  }
});

// --- Sondagem avançada: quais comandos existem em sequência/trilha/clipe ----
$("btnMetodos").addEventListener("click", async () => {
  try {
    const ppro = require("premierepro");
    const projeto = await ppro.Project.getActiveProject();
    const seq = await projeto.getActiveSequence();
    const trilha = await seq.getAudioTrack(1);
    const itens = await trilha.getTrackItems(1, false);
    const editor = await ppro.SequenceEditor.getEditor(seq);
    const nomes = (o) => {
      const r = new Set();
      let p = o;
      for (let i = 0; p && i < 4; i++) { Object.getOwnPropertyNames(p).forEach((n) => r.add(n)); p = Object.getPrototypeOf(p); }
      return Array.from(r).filter((n) => !/^(constructor|__)/.test(n)).sort();
    };
    mostrar("SEQUÊNCIA:\n" + nomes(seq).join(", ") + "\n\nTRILHA:\n" + nomes(trilha).join(", ") +
      "\n\nCLIPE DA TIMELINE:\n" + nomes(itens[0]).join(", ") + "\n\nEDITOR:\n" + nomes(editor).join(", "));
  } catch (e) {
    mostrar("Erro:\n" + (e && e.message ? e.message : e), true);
  }
});

// --- Passo 2: detectar silêncios pelo serviço local -----------------------
$("btnSilencios").addEventListener("click", async () => {
  const caminho = await obterCaminho();
  if (!caminho) return;
  mostrar("Analisando o áudio...");
  try {
    const r = await chamar("/silences", {
      path: caminho,
      noiseDb: lerNumero("limite", -31),
      minSilence: lerNumero("minimo", 0.5),
      padding: lerNumero("respiro", 0.25),
    });
    const removido = r.silences.reduce((soma, [a, b]) => soma + (b - a), 0);
    const linhas = r.keep.slice(0, 15).map(
      ([a, b], i) => (i + 1) + ". " + segundos(a) + " → " + segundos(b)
    );
    mostrar(
      r.keep.length + " trechos para manter, " + r.silences.length +
      " silêncios (" + segundos(removido) + " de " + segundos(r.duration) + ").\n\n" +
      linhas.join("\n") + (r.keep.length > 15 ? "\n..." : "")
    );
    // Próximo passo: usar r.keep para montar a sequência cortada no Premiere.
  } catch (e) {
    mostrar(e.message, true);
  }
});

// --- Passo 3: gerar legendas pelo serviço local ---------------------------
$("btnLegendas").addEventListener("click", async () => {
  const caminho = await obterCaminho();
  if (!caminho) return;
  mostrar("Transcrevendo... na primeira vez o modelo é baixado, então pode demorar.");
  try {
    const r = await chamar("/transcribe", {
      path: caminho,
      model: $("modelo").value,
      device: $("dispositivo").value,
      language: "pt",
    });
    mostrar(r.segments + " legendas salvas em:\n" + r.srt);
    // Próximo passo: importar o .srt e criar a faixa de legendas na sequência.
  } catch (e) {
    mostrar(e.message, true);
  }
});


// --- Recorte vertical: sondagem do que o Premiere permite ------------------
$("btnSondaVertical").addEventListener("click", () => semPressa(async () => {
  let etapa = "começando";
  const out = [];
  const nomes = (o) => {
    const r = new Set();
    let p = o;
    for (let i = 0; p && i < 4; i++) { Object.getOwnPropertyNames(p).forEach((n) => r.add(n)); p = Object.getPrototypeOf(p); }
    return Array.from(r).filter((n) => !/^(constructor|__)/.test(n)).sort();
  };
  try {
    const ppro = require("premierepro");
    const projeto = await ppro.Project.getActiveProject();
    const seq = await projeto.getActiveSequence();
    if (!seq) return mostrar("Nenhuma sequência ativa.", true);
    out.push("PROJETO: " + nomes(projeto).filter((n) => /equence|reate|ettings|mport/i.test(n)).join(", "));
    out.push("SEQUÊNCIA: " + nomes(seq).filter((n) => /ettings|ize|rame|ave|reate|et[A-Z]/.test(n)).join(", "));
    etapa = "ler as configurações da sequência";
    try {
      const cfg = await seq.getSettings();
      out.push("CONFIG: " + nomes(cfg).join(", "));
      for (const n of ["getVideoFrameRect", "getVideoFrameWidth", "getVideoFrameHeight"]) {
        if (typeof cfg[n] === "function") { try { out.push("  " + n + " = " + JSON.stringify(await cfg[n]())); } catch (e) { out.push("  " + n + " erro " + e.message); } }
      }
    } catch (e) { out.push("getSettings: " + (e && e.message ? e.message : e)); }
    try {
      const fr = await seq.getFrameSize();
      out.push("FRAME: " + JSON.stringify(fr));
    } catch (e) { out.push("getFrameSize: " + (e && e.message ? e.message : e)); }

    etapa = "ler o clipe de V1";
    const t = await seq.getVideoTrack(0);
    const itens = await t.getTrackItems(1, false);
    if (!itens.length) return mostrar(out.join("\n") + "\n\nV1 sem clipes.", false);
    const clipe = itens[0];
    out.push("CLIPE: " + nomes(clipe).filter((n) => /omponent|cale|osition|rop|ransform/i.test(n)).join(", "));
    const cadeia = await clipe.getComponentChain();
    const nc = cadeia.getComponentCount();
    for (let i = 0; i < nc; i++) {
      const comp = cadeia.getComponentAtIndex(i);
      let nome = "";
      try { nome = await comp.getMatchName(); } catch (e) { nome = "?"; }
      let np = 0;
      try { np = comp.getParamCount(); } catch (e) { /* nada */ }
      const ps = [];
      for (let j = 0; j < np; j++) {
        try {
          const p = comp.getParam(j);
          let v = "";
          try { v = JSON.stringify(await p.getStartValue()); } catch (e) { v = "(sem valor)"; }
          ps.push((p.displayName || p.name || j) + "=" + v);
        } catch (e) { ps.push(j + ":erro"); }
      }
      out.push("COMPONENTE " + i + " " + nome + ": " + ps.join("; "));
    }
    // detalhes dos campos Posição e Escala (componente Motion)
    try {
      const mov = cadeia.getComponentAtIndex(1);
      for (const j of [0, 1]) {
        const p = mov.getParam(j);
        out.push("PARAM " + j + " métodos: " + nomes(p).join(", "));
        for (const n of ["getValue", "getStartValue", "getKeyframeListAsTickTimes", "areKeyframesSupported", "isTimeVarying"]) {
          if (typeof p[n] === "function") {
            try {
              const v = await p[n]();
              const desc = v && typeof v === "object" ? "{" + nomes(v).filter((k) => !/^(has|is|prop|to|value)/.test(k)).join(",") + "} " + JSON.stringify(v) + " x=" + v.x + " y=" + v.y + " val=" + (v.value && JSON.stringify(v.value)) : String(v);
              out.push("  " + n + " -> " + desc);
            } catch (e) { out.push("  " + n + " erro: " + (e && e.message ? e.message : e)); }
          }
        }
      }
      out.push("PointF: " + (typeof ppro.PointF) + "  Constants: " + (ppro.Constants ? Object.keys(ppro.Constants).join(",") : "nenhum"));
    } catch (e) { out.push("detalhes do Motion: " + (e && e.message ? e.message : e)); }
    mostrar(out.join("\n"));
  } catch (e) {
    mostrar(out.join("\n") + "\n\nErro ao " + etapa + ":\n" + (e && e.message ? e.message : e), true);
  }
}));


// --- Recorte vertical 9:16: monta a sequência e enquadra o rosto de quem fala ---
$("btnVertical").addEventListener("click", () => semPressa(async () => {
  let etapa = "começando";
  const lerTempo = (txt, padrao) => {
    const t = String(txt || "").trim().replace(",", ".");
    if (!t) return padrao;
    const p = t.split(":").map(Number);
    if (p.some((x) => !isFinite(x))) return NaN;
    return p.length === 1 ? p[0] : p.length === 2 ? p[0] * 60 + p[1] : p[0] * 3600 + p[1] * 60 + p[2];
  };
  const INICIO = lerTempo($("estInicio").value, 60);
  const FIM = lerTempo($("estFim").value, 90);
  if (!(FIM > INICIO) || !(INICIO >= 0)) return mostrar("Confira Início e Fim (exemplo: 1:00 e 1:30). O Fim precisa ser maior que o Início.", true);
  if (FIM - INICIO > 180) return mostrar("Escolha um trecho de até 3 minutos por vez.", true);
  const LARG = 1080, ALT = 1920;
  const avisos = [];
  try {
    const ppro = require("premierepro");
    const projeto = await ppro.Project.getActiveProject();
    const origem = await projeto.getActiveSequence();
    if (!origem) return mostrar("Nenhuma sequência ativa (deixe a PODCAST ativa).", true);

    etapa = "ler os arquivos da sequência (deixe a PODCAST ativa)";
    const wav = await wavDoPodcast(ppro, origem);
    const cameras = {};
    for (const v of camerasUsadas()) cameras[v] = await caminhoDaTrilha(ppro, origem, "V", parseInt(v.slice(1), 10) - 1);

    etapa = "calcular cortes e rostos";
    mostrar("Calculando os cortes e procurando os rostos...\n(uns 1 a 2 minutos; não mexa no Premiere)");
    const plano = await chamar("/plano_vertical", {
      path: wav, cameras,
      pessoas: PODCAST.pessoas.map((p) => ({ nome: p.nome, canal: p.canal, camera: p.camera })),
      geral: PODCAST.geral, inicio: INICIO, fim: FIM,
    });
    const pecas = plano.pecas;

    etapa = "achar os arquivos no projeto";
    const itens = {};
    for (const [nome, caminho] of Object.entries({ ...cameras, WAV: wav })) {
      let achado = await acharClipe(ppro, projeto, caminho);
      if (!achado) { await projeto.importFiles([caminho]); await dormir(1500); achado = await acharClipe(ppro, projeto, caminho); }
      if (!achado) throw new Error("não achei " + nome + " no projeto");
      itens[nome] = achado;
    }

    const hora = new Date();
    const nome = "VERTICAL " + String(hora.getHours()).padStart(2, "0") + "h" + String(hora.getMinutes()).padStart(2, "0");
    let sequencia = null, editor = null;
    const usados = new Set();
    const camerasOrdem = Object.keys(cameras); // V1, V2, V3
    const trilhas = {};
    const totalPecas = camerasOrdem.length * pecas.length;
    let feitas = 0;
    // cada câmera fica na sua própria trilha (V1, V2, V3), cortada nos mesmos pontos;
    // só a câmera escolhida em cada trecho fica ativa, as outras ficam DESATIVADAS (nada é apagado)
    for (let ci = 0; ci < camerasOrdem.length; ci++) {
      const cam = camerasOrdem[ci];
      const alvo = itens[cam];
      const atraso = plano.atraso[cam].valor;
      for (let i = 0; i < pecas.length; i++) {
        const p = pecas[i];
        feitas++;
        mostrar("Montando o vídeo vertical (" + cam + "): peça " + feitas + " de " + totalPecas + "\nNão mexa no Premiere.");
        etapa = "definir entrada/saída da peça " + feitas + " (" + cam + ")";
        const tIni = await ppro.TickTime.createWithSeconds(p.a + atraso);
        const tFim = await ppro.TickTime.createWithSeconds(p.b + atraso);
        await executar(projeto, "Vertical: entrada e saída", () => alvo.clip.createSetInOutPointsAction(tIni, tFim));
        usados.add(cam);
        if (!sequencia) {
          etapa = "criar a sequência nova";
          sequencia = await projeto.createSequenceFromMedia(nome, alvo.clip);
          await dormir(1000);
          editor = await ppro.SequenceEditor.getEditor(sequencia);
          etapa = "mudar o tamanho da sequência para 1080x1920";
          try {
            const cfg = await sequencia.getSettings();
            cfg.setVideoFrameRect(new ppro.RectF(0, 0, LARG, ALT));
            projeto.lockedAccess(() => {
              projeto.executeTransaction((composto) => { composto.addAction(sequencia.createSetSettingsAction(cfg)); }, "Vertical: tamanho da sequência");
            });
            await dormir(800);
          } catch (e) { avisos.push("não consegui mudar o tamanho da sequência: " + (e && e.message ? e.message : e)); }
        } else {
          etapa = "colocar a peça " + feitas + " (" + cam + ") na timeline";
          const t = ci === 0 ? await sequencia.getEndTime() : await ppro.TickTime.createWithSeconds(p.t);
          await executar(projeto, "Vertical: colocar peça", () => editor.createOverwriteItemAction(alvo.item, t, ci, ci));
        }
      }
      etapa = "conferir a trilha de " + cam;
      const nV = await sequencia.getVideoTrackCount();
      if (nV <= ci) { avisos.push(cam + ": a trilha V" + (ci + 1) + " não foi criada"); trilhas[cam] = []; continue; }
      const q = await (await sequencia.getVideoTrack(ci)).getTrackItems(1, false);
      if (q.length !== pecas.length) avisos.push(cam + ": esperava " + pecas.length + " pedaços, achei " + q.length);
      trilhas[cam] = q;
    }

    // desativa os pedaços das câmeras que não são as escolhidas
    etapa = "desativar os pedaços não usados";
    for (const cam of camerasOrdem) {
      const q = trilhas[cam] || [];
      const alvos = [];
      for (let i = 0; i < Math.min(q.length, pecas.length); i++) if (pecas[i].camera !== cam) alvos.push(q[i]);
      for (let k = 0; k < alvos.length; k += 25) {
        const lote = alvos.slice(k, k + 25);
        projeto.lockedAccess(() => {
          projeto.executeTransaction((composto) => { for (const it of lote) composto.addAction(it.createSetDisabledAction(true)); }, "Vertical: desativar pedaços");
        });
        await dormir(500);
      }
    }

    // áudio dos microfones (WAV) contínuo por baixo, depois das 3 trilhas de áudio das câmeras
    etapa = "colocar o áudio dos microfones";
    const primeiraTrilhaWav = camerasOrdem.length;
    const wIni = await ppro.TickTime.createWithSeconds(INICIO);
    const wFim = await ppro.TickTime.createWithSeconds(FIM);
    await executar(projeto, "Vertical: entrada e saída (áudio)", () => itens.WAV.clip.createSetInOutPointsAction(wIni, wFim));
    const zero = await ppro.TickTime.createWithSeconds(0);
    await executar(projeto, "Vertical: colocar áudio", () => editor.createOverwriteItemAction(itens.WAV.item, zero, 0, primeiraTrilhaWav));
    for (const c of usados) await executar(projeto, "Vertical: limpar", () => itens[c].clip.createClearInOutPointsAction());
    await executar(projeto, "Vertical: limpar", () => itens.WAV.clip.createClearInOutPointsAction());
    try {
      const vivos = new Set(PODCAST.pessoas.map((p) => primeiraTrilhaWav + p.canal));
      const total = await sequencia.getAudioTrackCount();
      for (let i = 0; i < total; i++) { if (vivos.has(i)) continue; await (await sequencia.getAudioTrack(i)).setMute(true); }
    } catch (e) { avisos.push("não consegui silenciar trilhas: " + (e && e.message ? e.message : e)); }

    // enquadramento: posição e escala de cada pedaço, em todas as câmeras
    etapa = "enquadrar os rostos";
    const trabalhos = [];
    const resumo = [];
    for (const cam of camerasOrdem) {
      const q = trilhas[cam] || [];
      for (let i = 0; i < Math.min(q.length, pecas.length); i++) {
        const p = pecas[i];
        const c = p.crops[cam];
        const W = c.largura, H = c.altura;
        const s0 = ALT / H;                       // escala que enche a altura
        let s = s0;
        if (cam !== PODCAST.geral) s = s0 * 1.15; // folga para poder subir/descer o enquadramento
        if (cam !== PODCAST.geral && c.rostos > 0) s = Math.min(Math.max(s0 * 1.15, (0.16 * ALT) / (c.fh * H)), s0 * 2.2);
        const janL = LARG / s / W, janA = ALT / s / H;   // tamanho da janela, relativo ao quadro de origem
        const cx = Math.min(Math.max(c.cx, janL / 2), 1 - janL / 2);
        const cy = Math.min(Math.max(c.cy + 0.12 * janA, janA / 2), 1 - janA / 2); // rosto a ~38% da altura
        const posX = 0.5 + ((0.5 - cx) * W * s) / LARG;
        const posY = 0.5 + ((0.5 - cy) * H * s) / ALT;
        const cadeia = await q[i].getComponentChain();
        const mov = cadeia.getComponentAtIndex(1);
        trabalhos.push({ posicao: mov.getParam(0), escala: mov.getParam(1), posX, posY, escalaPct: s * 100 });
        if (pecas[i].camera === cam) resumo.push((i + 1) + ": " + cam + " " + p.a.toFixed(1) + "-" + p.b.toFixed(1) + " rosto " + c.rostos + " x=" + cx.toFixed(2) + " esc=" + (s * 100).toFixed(0) + "%");
      }
    }
    for (let k = 0; k < trabalhos.length; k += 8) {
      const lote = trabalhos.slice(k, k + 8);
      projeto.lockedAccess(() => {
        projeto.executeTransaction((composto) => {
          for (const w of lote) {
            composto.addAction(w.escala.createSetValueAction(w.escala.createKeyframe(w.escalaPct), true));
            composto.addAction(w.posicao.createSetValueAction(w.posicao.createKeyframe(new ppro.PointF(w.posX, w.posY)), true));
          }
        }, "Vertical: enquadrar");
      });
      await dormir(600);
    }

    mostrar("Pronto: sequência " + nome + " (" + LARG + "x" + ALT + "), " + pecas.length + " trechos x 3 câmeras, " + (FIM - INICIO).toFixed(0) + " s.\n" +
      (avisos.length ? "AVISOS:\n- " + avisos.join("\n- ") + "\n" : "") + resumo.slice(0, 12).join("\n"));
  } catch (e) {
    mostrar((avisos.length ? "Avisos:\n- " + avisos.join("\n- ") + "\n\n" : "") + "Erro ao " + etapa + ":\n" + (e && e.message ? e.message : e), true);
  }
}));


// --- Abas do painel ---------------------------------------------------------
(function () {
  const abas = ["Podcast", "Legendas", "Vertical", "Silencios", "Buscar", "Avancado"];
  const comTrecho = new Set(["Legendas", "Vertical"]);
  function abrir(nome) {
    abas.forEach((a) => {
      const conteudo = $(a);
      const botao = $("aba" + a);
      if (conteudo) conteudo.className = "aba" + (a === nome ? " visivel" : "");
      if (botao) botao.className = a === nome ? "pill ativa" : "pill";
    });
    const bloco = $("blocoTrecho");
    if (bloco) bloco.style.display = comTrecho.has(nome) ? "block" : "none";
  }
  abas.forEach((a) => { const b = $("aba" + a); if (b) b.addEventListener("click", () => abrir(a)); });
  abrir("Podcast");
})();


// --- Templates .mogrt: lista automática e escolha de arquivo ------------------
(function () {
  const sel = () => $("estEstilo");
  function adicionar(valor, rotulo) {
    const s = sel();
    if (!s) return null;
    for (const o of Array.from(s.options)) if (o.value === valor) return o;
    const op = document.createElement("option");
    op.value = valor;
    op.textContent = rotulo;
    s.appendChild(op);
    return op;
  }
  async function carregarLista() {
    try {
      const r = await chamar("/listar_mogrts", {});
      (r.templates || []).forEach((t) => {
        if (/Captions and Subtitles/i.test(t.caminho)) return; // esses já estão na lista fixa
        adicionar(t.caminho, "Meu: " + t.nome);
      });
    } catch (e) { /* servidor desligado: segue só com a lista fixa */ }
  }
  carregarLista();
  const ab = $("abaLegendas");
  if (ab) ab.addEventListener("click", carregarLista);

  const botao = $("btnEscolherMogrt");
  if (botao) botao.addEventListener("click", async () => {
    try {
      const fs = require("uxp").storage.localFileSystem;
      const arq = await fs.getFileForOpening({ types: ["mogrt"] });
      if (!arq) return;
      const caminho = arq.nativePath;
      const nome = String(caminho).split(/[\\/]/).pop().replace(/\.mogrt$/i, "");
      const op = adicionar(caminho, "Meu: " + nome);
      if (op) sel().value = caminho;
      mostrar("Template escolhido: " + nome + ". Agora clique em 'Criar legendas estilizadas'.");
    } catch (e) {
      mostrar("Não consegui abrir o seletor de arquivos (" + (e && e.message ? e.message : e) +
        "). Feche e abra o plugin no UXP Developer Tools (Unload e Load) e tente de novo.", true);
    }
  });
})();


// --- Buscar: o usuário escreve o assunto e o plugin separa só esses trechos --------
let ultimaBusca = null;
const fmt = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");

$("btnBuscar").addEventListener("click", () => semPressa(async () => {
  let etapa = "começando";
  try {
    const consulta = ($("buscaTexto").value || "").trim();
    if (!consulta) return mostrar("Escreva o assunto que você quer (exemplo: perdão, casamento).", true);
    const ppro = require("premierepro");
    const projeto = await ppro.Project.getActiveProject();
    const origem = await projeto.getActiveSequence();
    if (!origem) return mostrar("Nenhuma sequência ativa (deixe a PODCAST ativa).", true);
    etapa = "ler o áudio da sequência (deixe a PODCAST ativa)";
    const wav = await wavDoPodcast(ppro, origem);
    etapa = "procurar no que foi falado";
    mostrar("Procurando \"" + consulta + "\" na transcrição...");
    const r = await chamar("/buscar", { path: wav, consulta, contexto: $("buscaContexto").value });
    if (!r.passagens.length) {
      ultimaBusca = null;
      return mostrar("Não achei nada sobre \"" + consulta + "\" nas " + r.frases + " frases do podcast.\n" +
        "Dicas: use palavras que a pessoa realmente falou (ex.: perdoar em vez de misericórdia) e separe assuntos com vírgula.");
    }
    ultimaBusca = { consulta, passagens: r.passagens };
    const linhas = r.passagens.slice(0, 12).map((p, i) =>
      (i + 1) + ") " + fmt(p.ini) + " a " + fmt(p.fim) + " - " + p.texto);
    mostrar("Achei " + r.passagens.length + " trecho(s), total de " + fmt(r.duracao) + " (" + r.duracao + " s).\n" +
      linhas.join("\n") + (r.passagens.length > 12 ? "\n... e mais " + (r.passagens.length - 12) : "") +
      "\n\nSe estiver bom, clique em 'Montar sequência com esses trechos'.");
  } catch (e) {
    mostrar("Erro ao " + etapa + ":\n" + (e && e.message ? e.message : e), true);
  }
}));

$("btnBuscarMontar").addEventListener("click", () => semPressa(async () => {
  if (!ultimaBusca) return mostrar("Faça primeiro a busca (botão 'Buscar trechos').", true);
  const faixas = ultimaBusca.passagens.map((p) => [p.ini, p.fim]);
  mostrar("Montando a sequência só com os trechos sobre \"" + ultimaBusca.consulta + "\"...\n(pode levar alguns minutos; não mexa no Premiere)");
  await montarPodcast(Infinity, { faixas, prefixo: "BUSCA " });
}));

// --- Sobre: versões e atualização sem fechar o Premiere ---------------------------
const VERSAO_PAINEL = (typeof __PACOTE_VERSAO !== "undefined") ? __PACOTE_VERSAO : "dev";
async function atualizarSobre() {
  let servidor = "desligado (abra o atalho 'PODCAST PRO - Reiniciar servidor')";
  let versaoServ = null;
  try {
    const r = await fetch(SERVICO + "/ping");
    const d = await r.json();
    versaoServ = d.versao || "antiga";
    servidor = versaoServ;
  } catch (e) { /* servidor desligado */ }
  const linhas = ["PODCAST PRO V1", "Painel: versão " + VERSAO_PAINEL, "Programa local: versão " + servidor];
  if (versaoServ && versaoServ !== VERSAO_PAINEL) linhas.push("Atenção: as versões são diferentes. Rode o instalador mais novo e clique em \"Aplicar atualização\".");
  const caixa = $("sobreTexto");
  caixa.innerHTML = "";
  for (const l of linhas) { const d = document.createElement("div"); d.textContent = l; caixa.appendChild(d); }
}
atualizarSobre();
async function esperarServidor() {
  for (let i = 0; i < 40; i++) {
    await dormir(1000);
    try { const r = await fetch(SERVICO + "/ping"); if (r.ok) return true; } catch (e) { /* ainda reiniciando */ }
  }
  return false;
}
$("btnBuscarAtual").addEventListener("click", async () => {
  mostrar("Procurando atualização online...");
  try {
    const v = await (await fetch(SERVICO + "/atualizacao/verificar")).json();
    if (!v.ok) return mostrar(v.erro, true);
    if (!v.disponivel) return mostrar("Você já está na versão mais nova (" + v.atual + ").");
    mostrar("Baixando a versão " + v.nova + "...");
    const a = await (await fetch(SERVICO + "/atualizacao/aplicar", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
    if (!a.ok) return mostrar(a.erro || "Falha ao atualizar.", true);
    mostrar("Versão " + a.nova + " instalada. Reiniciando...");
    await dormir(1500);
    if (!(await esperarServidor())) return mostrar("O programa local não voltou. Use o atalho 'PODCAST PRO - Reiniciar servidor'.", true);
    location.reload();
  } catch (e) { mostrar("Não consegui atualizar: " + e, true); }
});
$("abaAvancado").addEventListener("click", atualizarSobre);
$("btnAtualizar").addEventListener("click", async () => {
  mostrar("Reiniciando o programa local...");
  try {
    await fetch(SERVICO + "/reiniciar", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  } catch (e) { /* já desligou */ }
  let voltou = false;
  for (let i = 0; i < 30 && !voltou; i++) {
    await dormir(1000);
    try { const r = await fetch(SERVICO + "/ping"); voltou = r.ok; } catch (e) { voltou = false; }
  }
  mostrar(voltou ? "Programa local reiniciado. Recarregando o painel..." : "O programa local não voltou. Use o atalho 'PODCAST PRO - Reiniciar servidor'.", !voltou);
  if (!voltou) return;
  await dormir(600);
  try { location.reload(); } catch (e) { mostrar("Programa local reiniciado. Para ver o painel novo, feche e abra o painel.", false); }
});
