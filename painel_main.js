const SERVICO = "http://127.0.0.1:8765";

const $ = (id) => document.getElementById(id);
const status = $("status");

function mostrar(texto, erro = false) {
  status.textContent = texto;
  status.className = erro ? "erro" : "";
  if (CARREGANDO.ativo && $("carregandoTexto")) $("carregandoTexto").textContent = String(texto).split("\n")[0].slice(0, 90);
}

// Indicador "carregando" no topo (a janela de informações fica embaixo).
const CARREGANDO = { ativo: false, timer: null, pos: 0 };
function carregando(ligar, erro) {
  const caixa = $("carregando"), barra = $("carregandoBarra"), txt = $("carregandoTexto");
  if (!caixa) return;
  if (ligar) {
    CARREGANDO.ativo = true;
    caixa.style.display = "block";
    barra.style.backgroundColor = "#ff6a2b";
    barra.style.width = "25%";
    txt.textContent = "Trabalhando... não mexa no Premiere.";
    if (CARREGANDO.timer) clearInterval(CARREGANDO.timer);
    CARREGANDO.pos = 0;
    CARREGANDO.timer = setInterval(() => {
      CARREGANDO.pos = (CARREGANDO.pos + 3) % 150;
      const p = CARREGANDO.pos <= 75 ? CARREGANDO.pos : 150 - CARREGANDO.pos; // vai e volta
      barra.style.marginLeft = p + "%";
    }, 70);
  } else {
    CARREGANDO.ativo = false;
    if (CARREGANDO.timer) { clearInterval(CARREGANDO.timer); CARREGANDO.timer = null; }
    barra.style.marginLeft = "0%";
    barra.style.width = "100%";
    const falhou = status.className === "erro";
    barra.style.backgroundColor = falhou ? "#c0392b" : "#2e7d4f";
    txt.textContent = falhou ? "✖ Deu erro. Toque aqui para ver as informações (embaixo)." : "✔ Terminou. Toque aqui para ver as informações (embaixo).";
  }
}

// mostra um relógio enquanto uma tarefa demorada roda, para dar para ver que não travou
async function comRelogio(texto, tarefa) {
  const t0 = Date.now();
  const pinta = () => { const s = Math.round((Date.now() - t0) / 1000); mostrar(texto + "\n(já faz " + s + " s" + (s > 150 ? " — está demorando mais que o normal" : "") + ")"); };
  pinta();
  const id = setInterval(pinta, 2000);
  try { return await tarefa(); } finally { clearInterval(id); }
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


// ---- Organização das legendas no projeto: tudo numa pasta só, sem acumular arquivos antigos ----
const NOME_BIN_LEG = "Legendas PODCAST PRO";
const ehArquivoLeg = (n) => /^leg\d+_.*\.mov$/i.test(String(n));

async function binLegendas(ppro, projeto, nomeBin) {
  const NOME = nomeBin || NOME_BIN_LEG;
  const raiz = await projeto.getRootItem();
  const achar = async () => {
    for (const it of await raiz.getItems()) {
      if (it.name !== NOME) continue;
      try { const f = ppro.FolderItem.cast(it); if (f) return f; } catch (e) { /* não é pasta */ }
    }
    return null;
  };
  let bin = await achar();
  if (bin) return bin;
  try { await executar(projeto, "Criar pasta de legendas", () => raiz.createBinAction(NOME, true)); } catch (e) { return null; }
  for (let w = 0; w < 10 && !bin; w++) { await dormir(300); bin = await achar(); }
  return bin; // null = não deu para criar: usa a raiz do projeto
}

// Importa os arquivos direto na pasta das legendas e devolve { pasta, porNome }.
async function importarLegendas(ppro, projeto, arquivos, nomeBin) {
  const nomeDe = (c) => String(c).split(/[\\/]/).pop();
  const pasta = (await binLegendas(ppro, projeto, nomeBin)) || (await projeto.getRootItem());
  await projeto.importFiles(arquivos, true, pasta, false);
  await dormir(1500);
  let itens = [];
  for (let w = 0; w < 30; w++) {
    itens = await pasta.getItems();
    const nomes = new Set(itens.map((x) => x.name));
    if (arquivos.every((a) => nomes.has(nomeDe(a)))) break;
    await dormir(1000);
  }
  return { pasta, porNome: new Map(itens.map((x) => [x.name, x])) };
}

// Move as legendas soltas para a pasta e tira do projeto as que não estão em nenhuma sequência.
async function organizarLegendas(ppro, projeto, limpar = true) {
  const r = { movidas: 0, removidas: 0, aviso: "" };
  const lote = async (nome, itens, fazAcao) => {
    for (let k = 0; k < itens.length; k += 25) {
      const parte = itens.slice(k, k + 25);
      projeto.lockedAccess(() => {
        projeto.executeTransaction((c) => { for (const it of parte) c.addAction(fazAcao(it)); }, nome);
      });
      await dormir(400);
    }
  };
  const raiz = await projeto.getRootItem();
  const pasta = await binLegendas(ppro, projeto);
  if (!pasta) { r.aviso = "não consegui criar a pasta de legendas"; return r; }
  const soltas = (await raiz.getItems()).filter((it) => ehArquivoLeg(it.name));
  if (soltas.length) {
    try { await lote("Legendas: mover para a pasta", soltas, (it) => raiz.createMoveItemAction(it, pasta)); r.movidas = soltas.length; }
    catch (e) { r.aviso = "não consegui mover as legendas soltas"; }
  }
  if (!limpar) return r;
  // nomes usados em QUALQUER sequência do projeto (se não der para ler todas, não apaga nada)
  const usados = new Set();
  try {
    const seqs = await projeto.getSequences();
    for (const sq of seqs) {
      const nV = await sq.getVideoTrackCount();
      for (let i = 0; i < nV; i++) {
        const its = await (await sq.getVideoTrack(i)).getTrackItems(1, false);
        for (const it of its) { try { usados.add((await it.getProjectItem()).name); } catch (e) { /* segue */ } }
      }
    }
  } catch (e) { r.aviso += (r.aviso ? "; " : "") + "não consegui ver todas as sequências, então não apaguei nada"; return r; }
  const dentro = (await pasta.getItems()).filter((it) => ehArquivoLeg(it.name));
  const sobras = dentro.filter((it) => !usados.has(it.name));
  if (sobras.length) {
    try {
      await lote("Legendas: tirar as não usadas", sobras, (it) => pasta.createRemoveItemAction(it));
      const depois = (await pasta.getItems()).filter((it) => ehArquivoLeg(it.name)).length;
      r.removidas = Math.max(0, dentro.length - depois);
      if (r.removidas === 0) r.aviso += (r.aviso ? "; " : "") + "o Premiere não deixou tirar as legendas antigas do projeto";
    } catch (e) { r.aviso += (r.aviso ? "; " : "") + "não consegui tirar as legendas antigas: " + (e && e.message ? e.message : e); }
  }
  // arquivos antigos no disco (só os de mais de 1 dia, para o Ctrl+Z ainda funcionar)
  try {
    const emUso = (await pasta.getItems()).filter((it) => ehArquivoLeg(it.name)).map((it) => it.name);
    for (const n of usados) if (ehArquivoLeg(n) && !emUso.includes(n)) emUso.push(n);
    await chamar("/legenda/limpar_disco", { emUso });
  } catch (e) { /* limpeza de disco é opcional */ }
  return r;
}
// Tira do projeto os criativos antigos que não estão mais em nenhuma sequência (fica só o que está em uso).
async function organizarCriativos(ppro, projeto) {
  const NOME = "Criativos PODCAST PRO";
  const ehCr = (n) => /^criativo_\d+\.mov$/i.test(String(n));
  const raiz = await projeto.getRootItem();
  let pasta = null;
  for (const it of await raiz.getItems()) {
    if (it.name !== NOME) continue;
    try { pasta = ppro.FolderItem.cast(it); } catch (e) { pasta = null; }
  }
  if (!pasta) return "";
  const usados = new Set();
  try {
    for (const sq of await projeto.getSequences()) {
      const n = await sq.getVideoTrackCount();
      for (let i = 0; i < n; i++) {
        for (const it of await (await sq.getVideoTrack(i)).getTrackItems(1, false)) { try { usados.add((await it.getProjectItem()).name); } catch (e) { /* segue */ } }
      }
    }
  } catch (e) { return ""; } // se não deu para ver todas as sequências, não apaga nada
  const sobras = (await pasta.getItems()).filter((it) => ehCr(it.name) && !usados.has(it.name));
  if (!sobras.length) return "";
  try {
    projeto.lockedAccess(() => { projeto.executeTransaction((c) => { for (const it of sobras) c.addAction(pasta.createRemoveItemAction(it)); }, "Criativos: tirar os antigos"); });
    await dormir(500);
    return " " + sobras.length + " criativo(s) antigo(s) tirados do projeto.";
  } catch (e) { return ""; }
}
const textoOrganizar = (r) => (r.movidas ? " " + r.movidas + " legenda(s) soltas foram para a pasta \"" + NOME_BIN_LEG + "\"." : "") +
  (r.removidas ? " " + r.removidas + " legenda(s) antiga(s) tiradas do projeto." : "") + (r.aviso ? " (" + r.aviso + ")" : "");

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
  carregando(true);
  try { await tarefa(); } finally { ocupado = false; carregando(false); }
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
let AUTO = null; // resultado da escolha automática de áudio (só durante uma montagem)
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
  { const o = document.createElement("option"); o.value = "-2"; o.textContent = "Automático"; sa.appendChild(o); }
  { const o = document.createElement("option"); o.value = "-1"; o.textContent = "Voz única"; sa.appendChild(o); }
  for (let i = 0; i < 12; i++) { const o = document.createElement("option"); o.value = String(i); o.textContent = rotuloAudio(i); sa.appendChild(o); }
  const usadas = LINHAS.ap.concat(LINHAS.pt).map((l) => parseInt(l.aud.value, 10)).filter((n) => n >= 0);
  sc.value = cam || (grupo === "ap" ? "V2" : "V3");
  sa.value = String(aud !== undefined ? aud : -2);
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
      const aud = parseInt(l.aud.value, 10);
      let vozUnica = aud === -1; // "Voz única": todos gravados juntos numa trilha só
      let trilhaAudio = aud >= 0 ? aud : 0;
      if (aud === -2) { // "Automático": usa o que a análise escolheu (se já rodou)
        if (AUTO && AUTO.vozUnica) { vozUnica = true; trilhaAudio = AUTO.trilha; }
        else if (AUTO && AUTO.mapa && AUTO.mapa[base] !== undefined) trilhaAudio = AUTO.mapa[base];
      }
      pessoas.push({ nome, trilhaAudio, camera: l.cam.value, vozUnica, auto: aud === -2 });
      if (g === "ap") apresentadores.push(nome);
    }
  }
  return { pessoas, apresentadores };
}

// Pergunta se quer adicionar as pessoas que faltam (mais vozes/microfones do que linhas escritas).
let LISTA_CONFIRMADA = false; // true depois que você clica em Concluir (ou em Continuar): não pergunto de novo
const PARAR_FLUXO = new Error("Escolha a câmera da pessoa nova em \"Selecionar participantes e apresentador\" e clique em Montar de novo.");
function perguntarPessoasFaltando(achadas, escritas, o_que, detalhe) {
  const faltam = achadas - escritas;
  return new Promise((resolve) => {
    popup("Achei " + achadas + " " + o_que + ", mas só " + escritas + " pessoas estão escritas",
      (detalhe ? detalhe + " " : "") + "Sem a pessoa na lista, ela não aparece nos cortes de câmera. Adicione " + (faltam === 1 ? "a pessoa que falta" : "as " + faltam + " pessoas que faltam") + " e escolha a câmera dela em \"Selecionar participantes e apresentador\"; depois clique em Montar de novo.",
      [{ rotulo: "Adicionar e escolher a câmera", cor: "azul", acao: () => {
          const usadas = new Set(lerPessoas().pessoas.map((p) => p.camera));
          usadas.add($("pGeral") ? $("pGeral").value : "V1");
          for (let k = 0; k < faltam; k++) {
            const cam = ["V1", "V2", "V3", "V4"].find((v) => !usadas.has(v)) || "V4";
            usadas.add(cam);
            criarLinha("pt", undefined, cam);
          }
          abrirParticipantes();
          resolve(true);
        } },
       { rotulo: "Continuar só com " + escritas, acao: () => { LISTA_CONFIRMADA = true; resolve(false); } }]);
  });
}

const PODCAST = {
  get pessoas() {
    const { pessoas } = lerPessoas();
    if (!pessoas.length) throw new Error("Escreva o nome de pelo menos uma pessoa em \"Participantes e apresentador\" (aba Podcast).");
    const base = PODCAST_BASE_WAV !== null ? PODCAST_BASE_WAV : Math.min(...pessoas.map((p) => p.trilhaAudio));
    return pessoas.map((p) => ({ ...p, canal: Math.max(0, p.trilhaAudio - base) }));
  },
  get vozUnica() { return lerPessoas().pessoas.some((p) => p.vozUnica); },
  get geral() { return $("pGeral") ? $("pGeral").value : "V1"; },
  get apresentadores() { return lerPessoas().apresentadores; },
  get prioridade() { return $("pPrior") ? parseInt($("pPrior").value, 10) || 0 : 0; },
  cortarSilencios: false, // neste material: só troca de câmera, nada é removido
};

(function () {
  if (!$("menuPartic")) return;
  criarLinha("ap", "Apresentador", "V2"); // áudio "Automático": o painel escolhe a melhor trilha
  criarLinha("pt", "Participante 01", "V3");
  if ($("pGeral")) $("pGeral").value = "V1";
  $("btnMaisApres").addEventListener("click", () => { LISTA_CONFIRMADA = false; criarLinha("ap"); });
  $("btnMaisPart").addEventListener("click", () => { LISTA_CONFIRMADA = false; criarLinha("pt"); });
  $("menuPartic").addEventListener("click", () => {
    AJUSTE_PEDIDO = false;
    if ($("btnConcluirPartic")) $("btnConcluirPartic").textContent = "✔ Concluir";
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

// Trecho do material que a sequência realmente usa (em segundos, no tempo do arquivo de áudio).
// Se você deixou só um pedaço na sequência, o painel trabalha só nesse pedaço. null = tudo.
async function recorteDaTrilha(ppro, sequencia, trilhaIdx) {
  try {
    const trilha = await sequencia.getAudioTrack(trilhaIdx);
    const itens = await trilha.getTrackItems(1, false);
    if (!itens.length) return null;
    let ini = Infinity, fim = -Infinity;
    for (const it of itens) {
      const a = await it.getInPoint();
      const b = await it.getOutPoint();
      const sa = a && a.seconds !== undefined ? a.seconds : Number(a);
      const sb = b && b.seconds !== undefined ? b.seconds : Number(b);
      if (isFinite(sa) && isFinite(sb) && sb > sa) { ini = Math.min(ini, sa); fim = Math.max(fim, sb); }
    }
    return isFinite(ini) && isFinite(fim) && fim > ini ? [ini, fim] : null;
  } catch (e) {
    return null;
  }
}

// "Automático": olha todas as trilhas de áudio da sequência, descarta o que é ambiente de câmera,
// efeitos e trilhas vazias, e escolhe os microfones de cada pessoa (ou a trilha master).
// Nada é apagado: o que não for usado fica só silenciado na sequência nova.
// Lembra qual áudio foi escolhido da última vez (para a mesma sequência/pessoas), em qualquer aba
let MEMORIA_AUDIO = null;
const assinaturaAudio = (faixas, alvo) => JSON.stringify([faixas.map((f) => [f.trilha, f.path]), alvo.map((p) => [p.nome, p.camera])]);
function lembrarAudio(sig, auto) {
  MEMORIA_AUDIO = { sig, auto };
  try { localStorage.setItem("ppMemoriaAudio", JSON.stringify(MEMORIA_AUDIO)); } catch (e) { /* sem armazenamento */ }
}
function lerMemoriaAudio(sig) {
  let m = MEMORIA_AUDIO;
  if (!m) { try { m = JSON.parse(localStorage.getItem("ppMemoriaAudio") || "null"); } catch (e) { m = null; } }
  return m && m.sig === sig ? m.auto : null;
}
async function garantirAudio(ppro, sequencia) {
  if (AUTO) return;
  const alvo = lerPessoas().pessoas.filter((p) => p.auto);
  if (!alvo.length) return;
  mostrar("Analisando as trilhas de áudio para escolher a melhor...\n(pode levar uns 30 segundos; não mexa no Premiere)");
  const nA = await sequencia.getAudioTrackCount();
  const faixas = [];
  for (let i = 0; i < nA; i++) {
    mostrar("Lendo as trilhas de áudio da sequência: " + (i + 1) + " de " + nA + "...");
    try { faixas.push({ trilha: i, path: await caminhoDaTrilha(ppro, sequencia, "A", i) }); } catch (e) { /* trilha vazia */ }
  }
  const sigAudio = assinaturaAudio(faixas, alvo);
  const jaFeito = lerMemoriaAudio(sigAudio);
  if (jaFeito) { // já escolhi o áudio desta sequência antes: usa o mesmo, sem perguntar e sem reanalisar
    AUTO = jaFeito;
    mostrar("Usando o áudio já escolhido antes para esta sequência.");
    return;
  }
  const cameras = {};
  for (const v of camerasUsadas()) cameras[v] = await caminhoDaTrilha(ppro, sequencia, "V", parseInt(v.slice(1), 10) - 1);
  const palpite0 = faixas.find((f) => !Object.values(cameras).includes(f.path));
  const recorte = palpite0 ? await recorteDaTrilha(ppro, sequencia, palpite0.trilha) : null;
  const r0 = await comRelogio("Analisando as trilhas de áudio (" + faixas.length + " trilhas)...\nSe já analisei esta sequência antes, é rápido.", () => chamar("/avaliar_audios", { faixas, cameras, recorte, pessoas: alvo.map((p) => ({ nome: p.nome, camera: p.camera })) }));
  const r = r0;
  const rot = (i) => "A" + (i + 1);
  if (!LISTA_CONFIRMADA && r.modo === "microfones" && r.mics.length > lerPessoas().pessoas.length) {
    const lista = r.mics.map((tr) => rot(tr)).join(", ");
    if (await perguntarPessoasFaltando(r.mics.length, lerPessoas().pessoas.length, "microfones com fala", "Trilhas: " + lista + ".")) throw PARAR_FLUXO;
  }
  if (!r.modo) throw new Error("Não achei nenhuma trilha de áudio com fala na sequência.");
  const cobertura = {};
  for (const f of r.faixas) cobertura[f.trilha] = f.cobertura;
  const resumo = r.faixas.filter((f) => f.tipo !== "vazia").map((f) => rot(f.trilha) + ": " + f.tipo).join(", ");
  if (r.modo === "voz_unica") {
    AUTO = { vozUnica: true, trilha: r.escolha.trilha };
    lembrarAudio(sigAudio, AUTO);
    mostrar("Áudio escolhido: " + rot(r.escolha.trilha) + " (trilha única).\nTrilhas analisadas: " + resumo);
    return;
  }
  const mapa = Object.assign({}, r.escolha);
  if (!r.confiavel) {
    const livres = r.mics.slice();
    let usouMaster = false;
    for (const p of alvo) {
      if (livres.length === 1) { mapa[p.nome] = livres[0]; break; }
      const palpite = r.escolha[p.nome];
      const escolhido = await new Promise((resolve) => {
        const botoes = livres.map((tr) => ({
          rotulo: (tr === palpite ? "★ " : "") + rot(tr) + " (fala " + Math.round((cobertura[tr] || 0) * 100) + "% do tempo)",
          cor: "azul", acao: () => resolve(tr),
        }));
        if (r.master !== null) botoes.push({ rotulo: "Usar a trilha master (" + rot(r.master) + "), todos juntos", cor: "verde", acao: () => resolve(-1) });
        popup("Qual é o microfone de " + p.nome + "?",
          "Não tive certeza de qual trilha é de cada pessoa. A estrela marca o meu palpite." + (r.master !== null ? " Se preferir, use a trilha master (todas as vozes misturadas); aí eu separo as vozes sozinho." : ""),
          botoes);
      });
      if (escolhido === -1) { usouMaster = true; break; }
      mapa[p.nome] = escolhido;
      livres.splice(livres.indexOf(escolhido), 1);
    }
    if (usouMaster) {
      AUTO = { vozUnica: true, trilha: r.master };
      lembrarAudio(sigAudio, AUTO);
      mostrar("Áudio escolhido: " + rot(r.master) + " (master).");
      return;
    }
  }
  AUTO = { mapa };
  lembrarAudio(sigAudio, AUTO);
  mostrar("Microfones escolhidos: " + Object.entries(mapa).map(([n, tr]) => n + " = " + rot(tr)).join(", ") + "\nTrilhas analisadas: " + resumo);
}

// Trilha única: separa as vozes sozinho; se não tiver certeza de quem é quem, pergunta.
async function resolverVozes(ppro, sequencia, wav, cameras, recorte) {
  const pess = PODCAST.pessoas.map((p) => ({ nome: p.nome, camera: p.camera }));
  mostrar("Separando as vozes da trilha única...\n(pode levar um minuto; não mexa no Premiere)");
  const r = await chamar("/vozes", { path: wav, canal: PODCAST.pessoas[0].canal, recorte, cameras, pessoas: pess, n: pess.length });
  if (!LISTA_CONFIRMADA && r.kSugerido && r.kSugerido > pess.length) {
    if (await perguntarPessoasFaltando(r.kSugerido, pess.length, "vozes diferentes")) throw PARAR_FLUXO;
  }
  const mapa = Object.assign({}, r.mapa);
  if (!r.confiavel) {
    const livres = pess.map((p) => p.nome);
    const voces = Object.keys(r.mapa).sort((a, b) => Number(a) - Number(b));
    for (let k = 0; k < voces.length; k++) {
      const v = voces[k];
      const palpite = r.mapa[v];
      if (livres.length === 1) { mapa[v] = livres[0]; break; }
      const amostras = (r.amostras[v] || [0]);
      let ia = 0;
      const escolhido = await new Promise((resolve) => {
        const botoes = [{
          rotulo: "Ir ao trecho desta voz (" + amostras.length + " exemplos; clique de novo para o próximo)", fica: true,
          acao: async () => {
            try {
              const tt = await ppro.TickTime.createWithSeconds(amostras[ia % amostras.length]);
              ia++;
              await sequencia.setPlayerPosition(tt);
            } catch (e) { /* segue */ }
          },
        }];
        for (const nome of livres) botoes.push({ rotulo: (nome === palpite ? "★ " : "") + nome, cor: "azul", acao: () => resolve(nome) });
        popup("Quem é a Voz " + (k + 1) + "? (" + (k + 1) + " de " + voces.length + ")",
          "Não tive certeza de quem é cada voz. Clique no primeiro botão para ir até um trecho em que ela fala, escute no Premiere (barra de espaço) e escolha o nome abaixo." + (palpite ? " A estrela marca o meu palpite." : ""),
          botoes);
      });
      mapa[v] = escolhido;
      livres.splice(livres.indexOf(escolhido), 1);
    }
  }
  const cam = {};
  for (const p of pess) cam[p.nome] = p.camera;
  return r.trechos.map((t) => ({ ini: t.ini, fim: t.fim, quem: mapa[String(t.voz)], camera: cam[mapa[String(t.voz)]] || null }));
}

// --- Podcast: monta a sequência (câmeras sincronizadas + cortes) -------------
// limite = até quantos segundos da sequência nova montar (Infinity = tudo).
async function montarPodcast(limite, opcoes = {}) {
  const tinha = !!AUTO;
  try { return await montarPodcastInterno(limite, opcoes); } finally { if (!tinha) AUTO = null; }
}

async function montarPodcastInterno(limite, opcoes = {}) {
  let etapa = "começando";
  try {
    const ppro = require("premierepro");
    const projeto = await ppro.Project.getActiveProject();
    const origem = await projeto.getActiveSequence();
    if (!origem) return mostrar("Nenhuma sequência ativa.", true);

    etapa = "escolher o melhor áudio";
    await garantirAudio(ppro, origem);
    etapa = "ler os arquivos da sequência";
    const wav = await wavDoPodcast(ppro, origem);
    const cameras = {};
    for (const v of camerasUsadas()) cameras[v] = await caminhoDaTrilha(ppro, origem, "V", parseInt(v.slice(1), 10) - 1);

    etapa = "ver qual pedaço da sequência usar";
    const recorte = await recorteDaTrilha(ppro, origem, PODCAST.pessoas[0].trilhaAudio);
    let trechosProntos = null;
    if (PODCAST.vozUnica) {
      etapa = "separar as vozes";
      trechosProntos = await resolverVozes(ppro, origem, wav, cameras, recorte);
    }

    etapa = "calcular o plano de cortes";
    mostrar("Calculando sincronia e cortes" + ($("corrigirCam") && $("corrigirCam").value === "1" ? " e procurando tremidas nas câmeras" : "") + "...\n(pode levar alguns minutos; não mexa no Premiere)");
    const plano = await chamar("/plano_podcast", {
      path: wav, cameras,
      pessoas: PODCAST.pessoas.map((p) => ({ nome: p.nome, canal: p.canal, camera: p.camera })),
      geral: PODCAST.geral, apresentadores: PODCAST.apresentadores, prioridade: PODCAST.prioridade,
      minimo: lerNumero("minimo"), respiro: lerNumero("respiro"),
      cortarSilencios: PODCAST.cortarSilencios,
      faixas: opcoes.faixas || null,
      trechosProntos, recorte,
      corrigirCamera: $("corrigirCam") && $("corrigirCam").value === "1" ? ($("sensCam") ? $("sensCam").value : "media") : null,
    });
    const pecas = plano.pecas.filter((p) => p.t < limite);
    const keeps = plano.keeps.filter((k) => k.t < limite);
    if (!pecas.length) return mostrar("O plano não gerou nenhum trecho.", true);

    // equaliza o volume das vozes (gera um áudio novo; o original não é mexido)
    let eq = null;
    if ($("eqVol") && $("eqVol").value === "1") {
      etapa = "equalizar o volume das vozes";
      mostrar("Equalizando o volume das vozes...\n(pode levar um minuto; não mexa no Premiere)");
      const canais = Array.from(new Set(PODCAST.pessoas.map((p) => p.canal)));
      eq = await chamar("/equalizar", PODCAST.vozUnica
        ? { path: wav, canal: canais[0], trechos: trechosProntos, recorte }
        : { path: wav, canais, recorte });
    }
    const wavLinha = eq ? eq.arquivo : wav;
    const desloc = eq ? eq.offset : 0;

    etapa = "achar os arquivos no projeto";
    const itens = {};
    for (const [nome, caminho] of Object.entries({ ...cameras, WAV: wavLinha })) {
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
      const tIni = await ppro.TickTime.createWithSeconds(Math.max(0, k.a - desloc));
      const tFim = await ppro.TickTime.createWithSeconds(Math.max(0, k.b - desloc));
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
      const vivos = new Set(PODCAST.pessoas.map((p) => primeiraTrilhaWav + (eq ? eq.mapa[String(p.canal)] : p.canal)));
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
      "Atraso das câmeras: " + atrasos + (recorte ? "\nTrecho usado: " + recorte[0].toFixed(1) + " a " + recorte[1].toFixed(1) + " s do material" : "") + (plano.trocasPorDefeito && $("corrigirCam") && $("corrigirCam").value === "1" ? "\nCorreção de câmera: " + (plano.trocasPorDefeito.length ? plano.trocasPorDefeito.length + " troca(s) por tremida/movimento brusco: " + plano.trocasPorDefeito.slice(0, 6).map((x) => { const s = Math.max(0, x.a - (recorte ? recorte[0] : 0)); return Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0") + " " + x.de + "→" + x.para; }).join(", ") + (plano.trocasPorDefeito.length > 6 ? "..." : "") : "nenhum defeito encontrado") : "") + (eq ? "\nVolume equalizado (ajuste em dB): " + Object.entries(eq.ganhos).map(([k, v]) => k + " " + (v > 0 ? "+" : "") + v).join(", ") : "") + "\nTrilhas silenciadas: " + silenciadas + falhaMute +
      (avisos.length ? "\nAVISOS:\n- " + avisos.join("\n- ") : "\nSem avisos.") + "\n" + linhas.join("\n"));
    return true;
  } catch (e) {
    if (e === PARAR_FLUXO) mostrar(e.message); else mostrar("Erro ao " + etapa + ":\n" + (e && e.message ? e.message : e), true);
  }
}

// ---- Pop-up simples dentro do painel (aparece no topo da aba Podcast) ----
function popup(titulo, texto, botoes) {
  $("popTitulo").textContent = titulo;
  $("popTexto").textContent = texto;
  const area = $("popBotoes");
  while (area.firstChild) area.removeChild(area.firstChild);
  for (const b of botoes) {
    const d = document.createElement("div");
    d.className = "pb " + (b.cor || "");
    d.textContent = b.rotulo;
    d.addEventListener("click", () => { if (!b.fica) $("popup").style.display = "none"; if (b.acao) b.acao(); });
    area.appendChild(d);
  }
  // a pergunta aparece SEMPRE logo abaixo da barra do topo, em qualquer aba (antes ficava escondida na aba Podcast)
  try { const c = $("carregando"), pp = $("popup"); if (c && c.parentNode && pp) c.parentNode.insertBefore(pp, c.nextSibling); } catch (e) { /* segue */ }
  $("popup").style.display = "block";
  try { mostrar("Preciso da sua resposta: veja a pergunta aqui em cima ↑"); } catch (e) { /* segue */ }
  try { window.scrollTo(0, 0); document.documentElement.scrollTop = 0; document.body.scrollTop = 0; } catch (e) { /* segue */ }
}

let AJUSTE_PEDIDO = false; // true quando o painel abriu esta seção no meio de uma montagem
function recolherParticipantes() {
  $("corpoPartic").style.display = "none";
  $("setaPartic").textContent = "▸";
}
function abrirParticipantes() {
  AJUSTE_PEDIDO = true;
  if ($("btnConcluirPartic")) $("btnConcluirPartic").textContent = "✔ Concluir e montar o podcast";
  $("corpoPartic").style.display = "block";
  $("setaPartic").textContent = "▾";
  try { $("menuPartic").scrollIntoView(); } catch (e) { /* segue */ }
}

// Botão "Montar podcast completo": 1) sincroniza, 2) corta as câmeras, 3) oferece refinar.
async function fluxoPodcastCompleto() {
  let etapa = "começando";
  try {
    const ppro = require("premierepro");
    const projeto = await ppro.Project.getActiveProject();
    const origem = await projeto.getActiveSequence();
    if (!origem) return popup("Nenhuma sequência aberta", "Abra a sequência com as câmeras e o áudio dos microfones e clique de novo.", [{ rotulo: "Entendi" }]);

    // sem câmeras para cortar? avisa antes de gastar tempo
    etapa = "conferir as câmeras";
    const cams = camerasUsadas();
    if (cams.length < 2) {
      return popup("Não há câmeras para cortar",
        "Só uma câmera foi escolhida (" + cams.join(", ") + "), então não existe troca de câmera a fazer. Em \"Selecionar participantes e apresentador\", escolha um vídeo diferente para cada pessoa.",
        [{ rotulo: "Abrir participantes e apresentador", cor: "azul", acao: abrirParticipantes }, { rotulo: "Fechar" }]);
    }

    // PASSO 1: sincronia
    etapa = "conferir a sincronia";
    mostrar("Passo 1 de 2: conferindo a sincronia das câmeras com o áudio...\n(uns 20 segundos; não mexa no Premiere)");
    let wav;
    try {
      AUTO = null;
      await garantirAudio(ppro, origem);
      wav = await wavDoPodcast(ppro, origem);
    } catch (e) {
      const m = String(e && e.message ? e.message : e);
      if (m.indexOf("não tem as trilhas") >= 0) {
        let nome = "", nV = 0, nA = 0;
        try { nome = origem.name || ""; nV = await origem.getVideoTrackCount(); nA = await origem.getAudioTrackCount(); } catch (x) { /* segue */ }
        mostrar("Parei: a sequência aberta não bate com as trilhas escolhidas.");
        return popup("A sequência aberta não bate com as trilhas escolhidas",
          "A sequência ativa" + (nome ? " (" + nome + ")" : "") + " tem " + nV + " trilha(s) de vídeo e " + nA + " de áudio, mas as caixas pedem: " + m.split("trilhas:")[1].split(".")[0].trim() + ". Abra a sequência original do podcast (a que tem as câmeras e os microfones) ou ajuste os números V e A em \"Selecionar participantes e apresentador\".",
          [{ rotulo: "Ajustar participantes e apresentador", cor: "azul", acao: abrirParticipantes }, { rotulo: "Fechar" }]);
      }
      throw e;
    }
    const caminhos = [];
    for (const v of cams) caminhos.push(await caminhoDaTrilha(ppro, origem, "V", parseInt(v.slice(1), 10) - 1));
    const sync = await chamar("/sync", { path: wav, outros: caminhos });
    const desvios = sync.resultados.map((r) => Math.abs(r.deslocamento));
    const jaSincronizado = desvios.every((d) => d < 0.05);
    const resumoSync = jaSincronizado
      ? "Os materiais já estavam sincronizados; fui direto para os cortes."
      : "Sincronia ajustada na sequência nova (atrasos: " + sync.resultados.map((r, i) => cams[i] + " " + r.deslocamento.toFixed(2) + " s").join(", ") + ").";

    // PASSO 2: cortes automáticos de câmera (já considera a sincronia)
    etapa = "cortar as câmeras";
    mostrar(resumoSync + "\nPasso 2 de 2: cortando as câmeras automaticamente...");
    const ok = await montarPodcast(Infinity);
    if (!ok) return;

    popup("Cortes prontos",
      resumoSync + " Os cortes foram feitos automaticamente. Quer refinar mais? Em \"Selecionar participantes e apresentador\" você muda quem é apresentador e quanto a imagem dele é priorizada; depois clique em \"Montar podcast completo\" de novo.",
      [{ rotulo: "Refinar cortes", cor: "azul", acao: abrirParticipantes }, { rotulo: "Está bom assim", cor: "verde" }]);
  } catch (e) {
    if (e === PARAR_FLUXO) mostrar(e.message); else mostrar("Erro ao " + etapa + ":\n" + (e && e.message ? e.message : e), true);
  } finally {
    AUTO = null;
  }
}
$("btnPodcastTudo").addEventListener("click", () => semPressa(fluxoPodcastCompleto));

// --- Legendas do podcast: transcrição por palavra (só os microfones) ---------
$("btnLegendasPodcast").addEventListener("click", () => semPressa(async () => {
  let relogio = null;
  try {
    const ppro = require("premierepro");
    const projeto = await ppro.Project.getActiveProject();
    const sequencia = await projeto.getActiveSequence();
    if (!sequencia) return mostrar("Nenhuma sequência ativa.", true);
    AUTO = null;
    await garantirAudio(ppro, sequencia);
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
const legendar = (modo) => () => semPressa(async () => {
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
  const AJUSTE = parseFloat(String(($("estAjuste") && $("estAjuste").value) || "0").replace(",", "."));
  const ESCOLHA_AUDIO = ($("estAudio") && $("estAudio").value) || "auto";
  try {
    const ppro = require("premierepro");
    const projeto = await ppro.Project.getActiveProject();
    const seq = await projeto.getActiveSequence();
    if (!seq) return mostrar("Nenhuma sequência ativa. Clique na sequência na timeline.", true);
    const fimSeq = await sec(() => seq.getEndTime());
    if (!(fimSeq > 0)) return mostrar("A sequência está vazia.", true);
    let INICIO = 0, FIM = fimSeq;
    if (modo === "inout") {
      let pin = 0, pout = 0;
      try { pin = await sec(() => seq.getInPoint()); pout = await sec(() => seq.getOutPoint()); } catch (e) { pin = 0; pout = 0; }
      INICIO = Math.max(0, pin);
      FIM = Math.min(pout, fimSeq);
      if (!(FIM > INICIO + 0.5)) return mostrar("Marque o trecho na timeline: ponha o cursor no começo e aperte I, depois no fim e aperte O. Depois clique de novo em LEGENDAR IN/OUT.", true);
    }

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
        ".\nConfira a trilha de áudio da fala.", true);
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
        if (ini >= INICIO - 0.01 && ini < FIM) {
          const aj = (isFinite(AJUSTE) ? AJUSTE : 0);
          const ini2 = Math.max(0, ini + aj);
          todas.push({ ...l, seqIni: ini2, seqFim: Math.min(fim + aj, c.fim) });
        }
      }
    }
    if (!todas.length) return mostrar("Não encontrei falas nesse trecho. Confira a trilha de áudio da fala.", true);
    todas.sort((x, y) => x.seqIni - y.seqIni);

    // ---- estilos Criativo: o programa desenha TODAS as legendas num único vídeo transparente
    if (todas.every((l) => l.tipo === "overlay")) {
      etapa = "desenhar as legendas";
      const base = todas[0].seqIni;
      let LARG = 1920, ALT = 1080, FPS = 30;
      try { const fs = await seq.getFrameSize(); if (fs && fs.width > 0) { LARG = fs.width; ALT = fs.height; } } catch (e) { /* usa 1920x1080 */ }
      mostrar("Desenhando " + todas.length + " legendas (" + ESTILO + ") num vídeo transparente...\n" +
        "Isso pode levar alguns minutos. Não feche o Premiere.");
      const ov = await chamar("/legendas_overlay", {
        estilo: ESTILO, w: LARG, h: ALT, fps: FPS,
        separado: true,
        blocos: todas.map((l) => ({ a: l.seqIni - base, b: l.seqFim - base, texto: l.texto })),
      });
      etapa = "importar as legendas";
      mostrar("Colocando " + ov.itens.length + " legendas na trilha V" + (iv + 1) + "...");
      const nomeDe = (c) => c.split(/[\\/]/).pop();
      const { porNome } = await importarLegendas(ppro, projeto, ov.itens.map((x) => x.arquivo));
      const edOv = await ppro.SequenceEditor.getEditor(seq);
      let postos = 0;
      const faltaram = [];
      for (let i = 0; i < ov.itens.length; i++) {
        const x = ov.itens[i];
        const item = porNome.get(nomeDe(x.arquivo));
        if (!item) { faltaram.push(i + 1); continue; }
        etapa = "colocar a legenda " + (i + 1);
        const tOv = await ppro.TickTime.createWithSeconds(base + x.a);
        await executar(projeto, "Legenda: colocar", () => edOv.createOverwriteItemAction(item, tOv, iv, ia));
        postos++;
        if (i % 5 === 0) mostrar("Colocando legendas na timeline: " + (i + 1) + " de " + ov.itens.length + "...");
      }
      let orgTxt = "";
      try { orgTxt = textoOrganizar(await organizarLegendas(ppro, projeto, true)); } catch (e) { /* organização é opcional */ }
      mostrar("Pronto! " + postos + " legendas " + ESTILO + " na trilha V" + (iv + 1) + ". Cada legenda é um clipe: " +
        "arraste para acertar o tempo e puxe a ponta para mudar a duração.\n" +
        "Fala lida da trilha A" + (ia + 1) + ". (Para desfazer: Ctrl+Z.)" + orgTxt +
        (faltaram.length ? "\nNão importadas: " + faltaram.join(", ") : ""));
      return;
    }

    // ---- coloca na trilha livre
    etapa = "inserir as legendas";
    const editor = await ppro.SequenceEditor.getEditor(seq);
    const falhas = [];
    // trilha de áudio vazia para os modelos em projeto (eles trazem um áudio mudo junto)
    let iaLivre = -1;
    for (let i = nA - 1; i >= 0; i--) if (i !== ia && !audio[i].some(sobrepoe)) { iaLivre = i; break; }
    const inserirProjeto = async (l) => {
      const tIni = await ppro.TickTime.createWithSeconds(l.seqIni);
      if (iaLivre < 0) return "não há trilha de áudio vazia (adicione uma trilha de áudio vazia e tente de novo)";
      let ultimo = "";
      for (let tentativa = 1; tentativa <= 3; tentativa++) {
        try {
          const antes = (await (await projeto.getRootItem()).getItems()).filter((it) => it.name === l.nome).length;
          await projeto.importSequences(l.arquivo, [ppro.Guid.fromString(l.guid)]);
          let achados = [];
          for (let w = 0; w < 10; w++) {
            await dormir(500);
            achados = (await (await projeto.getRootItem()).getItems()).filter((it) => it.name === l.nome);
            if (achados.length > antes) break;
          }
          if (achados.length <= antes) throw new Error("a sequência importada não apareceu");
          await executar(projeto, "Legenda: colocar", () => editor.createOverwriteItemAction(achados[achados.length - 1], tIni, iv, iaLivre));
          return "";
        } catch (e) {
          ultimo = e && e.message ? e.message : String(e);
          await dormir(1500);
        }
      }
      return ultimo;
    };
    const inserir = async (l) => {
      if (l.tipo === "projeto") return inserirProjeto(l);
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
      await dormir(i >= todas.length - 2 ? 2500 : 1500);
    }
    // modelos em projeto: cada clipe entra com ~5 s; aparar o fim para a duração real da fala
    if (todas.some((l) => l.tipo === "projeto")) {
      etapa = "ajustar a duração dos modelos";
      mostrar("Ajustando a duração das legendas...");
      try {
        const lista = await (await seq.getVideoTrack(iv)).getTrackItems(1, false);
        for (const c of lista) {
          const ini = await sec(() => c.getStartTime()), fimC = await sec(() => c.getEndTime());
          const l = todas.find((x) => x.tipo === "projeto" && Math.abs(x.seqIni - ini) < 0.06);
          if (l && l.seqFim > ini + 0.2 && fimC > l.seqFim + 0.05) {
            const tFim = await ppro.TickTime.createWithSeconds(l.seqFim);
            await executar(projeto, "Legenda: duração", () => c.createSetEndAction(tFim));
          }
        }
      } catch (e) { falhas.push("ajuste de duração: " + (e && e.message ? e.message : e)); }
    }
    mostrar("Terminando de carregar as legendas no Premiere...");
    await dormir(8000);

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
});
$("btnLegSeq").addEventListener("click", legendar("seq"));
$("btnLegInOut").addEventListener("click", legendar("inout"));

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
async function fluxoVertical(modo, janela) { // modo: "seq" (tudo), "inout" (pontos In/Out) ou "janela" ({ini,fim} em tempo da sequência)
  let etapa = "começando";
  let INICIO = 0, FIM = 0;
  const LARG = 1080, ALT = 1920;
  const avisos = [];
  try {
    const ppro = require("premierepro");
    const projeto = await ppro.Project.getActiveProject();
    const origem = await projeto.getActiveSequence();
    if (!origem) return mostrar("Nenhuma sequência ativa (deixe a PODCAST ativa).", true);
    {
      const secT = async (f) => { const t = await f(); return t && t.seconds !== undefined ? t.seconds : Number(t); };
      const fimSeq = await secT(() => origem.getEndTime());
      if (!(fimSeq > 0)) return mostrar("A sequência está vazia.", true);
      if (modo === "janela") { INICIO = Math.max(0, janela.ini); FIM = Math.min(fimSeq, janela.fim); }
      else if (modo === "inout") {
        let pin = 0, pout = 0;
        try { pin = await secT(() => origem.getInPoint()); pout = await secT(() => origem.getOutPoint()); } catch (e) { pin = 0; pout = 0; }
        INICIO = Math.max(0, pin); FIM = Math.min(pout, fimSeq);
        if (!(FIM > INICIO + 0.5)) return mostrar("Marque o trecho na timeline: cursor no começo e tecla I, cursor no fim e tecla O. Depois clique de novo em CONVERTER IN/OUT.", true);
      } else { INICIO = 0; FIM = fimSeq; }
      if (FIM - INICIO > 900) { FIM = INICIO + 900; avisos.push("a sequência passa de 15 minutos: converti só os primeiros 15 minutos"); }
      if (!(FIM > INICIO + 0.5)) return mostrar("Trecho curto demais.", true);
    }

    // ---- 1. lê os cortes que JÁ estão na sequência (nada é reanalisado)
    etapa = "ler os cortes da sequência (deixe a sequência do podcast já montada ativa)";
    mostrar("Lendo os cortes que já estão na sequência...");
    const sec = async (f) => { const t = await f(); return t && t.seconds !== undefined ? t.seconds : Number(t); };
    const sobrepoe = (a, b) => b > INICIO + 0.05 && a < FIM - 0.05;
    const lerFaixa = async (tipo, idx) => {
      const tr = tipo === "V" ? await origem.getVideoTrack(idx) : await origem.getAudioTrack(idx);
      const its = await tr.getTrackItems(1, false);
      const lista = [];
      for (const it of its) {
        const ini = await sec(() => it.getStartTime()), fim = await sec(() => it.getEndTime());
        if (!sobrepoe(ini, fim)) continue;
        let des = false; try { des = !!(await it.isDisabled()); } catch (e) { des = false; }
        let caminho = null;
        try { const pi = await it.getProjectItem(); const cp = await ppro.ClipProjectItem.cast(pi); caminho = await cp.getMediaFilePath(); } catch (e) { caminho = null; }
        lista.push({ ini, fim, entrada: await sec(() => it.getInPoint()), des, caminho });
      }
      lista.sort((a, b) => a.ini - b.ini);
      return lista;
    };
    const camerasOrdem = camerasUsadas();
    const videos = {}, cameras = {};
    const nVseq = await origem.getVideoTrackCount();
    for (const cam of camerasOrdem) {
      const idx = parseInt(cam.slice(1), 10) - 1;
      if (idx + 1 > nVseq) throw new Error("a sequência não tem a trilha " + cam);
      const lista = await lerFaixa("V", idx);
      if (!lista.length) throw new Error("a trilha " + cam + " não tem nada entre " + INICIO + " s e " + FIM + " s da sequência");
      const comArq = lista.find((c) => c.caminho);
      if (!comArq) throw new Error("não consegui ler o arquivo da trilha " + cam);
      videos[cam] = lista; cameras[cam] = String(comArq.caminho);
    }
    const doItem = (cam, T) => { // trecho (item) da câmera que cobre o tempo T, ou o mais próximo
      const l = videos[cam];
      let m = l.find((c) => T >= c.ini - 0.001 && T <= c.fim + 0.001);
      if (!m) m = l.reduce((x, y) => (Math.abs(y.ini - T) < Math.abs(x.ini - T) ? y : x));
      return m;
    };
    const arquivoT = (cam, T) => { const m = doItem(cam, T); return m.entrada + (T - m.ini); }; // tempo dentro do arquivo
    // pontos de corte = começos/fins dos clipes de todas as câmeras
    let cortes = [INICIO, FIM];
    for (const cam of camerasOrdem) for (const c of videos[cam]) { if (c.ini > INICIO + 0.03 && c.ini < FIM - 0.03) cortes.push(c.ini); if (c.fim > INICIO + 0.03 && c.fim < FIM - 0.03) cortes.push(c.fim); }
    cortes.sort((a, b) => a - b);
    cortes = cortes.filter((v, k) => k === 0 || v - cortes[k - 1] > 0.04);
    const pecas = [];
    let ultimaCam = camerasOrdem[0];
    for (let k = 0; k + 1 < cortes.length; k++) {
      const a = cortes[k], b = cortes[k + 1], meio = (a + b) / 2;
      let camAtiva = null;
      for (const cam of camerasOrdem) { if (videos[cam].some((c) => !c.des && meio >= c.ini && meio <= c.fim)) { camAtiva = cam; break; } }
      if (!camAtiva) camAtiva = ultimaCam;
      ultimaCam = camAtiva;
      const arq = {};
      for (const cam of camerasOrdem) arq[cam] = [arquivoT(cam, a + 0.001), arquivoT(cam, b - 0.001) + 0.001];
      pecas.push({ a, b, t: a - INICIO, camera: camAtiva, arq });
    }
    if (!pecas.length) throw new Error("não achei cortes nesse trecho da sequência");

    // ---- 2. só procura os rostos (o servidor guarda o resultado para repetir mais rápido)
    etapa = "procurar os rostos";
    for (const [c, caminho] of Object.entries(cameras)) { if (!caminho || caminho === "undefined" || caminho === "null") throw new Error("o Premiere não me deu o caminho do arquivo da câmera " + c + " (veio: " + JSON.stringify(caminho) + ")"); }
    const rr = await comRelogio("Procurando os rostos para enquadrar (" + pecas.length + " trechos)...\n(só isso é calculado; os cortes já feitos são reaproveitados)", () => chamar("/crops_vertical", {
      path: Object.values(cameras)[0], cameras, geral: PODCAST.geral, pecas: pecas.map((p) => ({ arq: p.arq })),
    }));
    pecas.forEach((p, i) => { p.crops = rr.crops[i]; });

    etapa = "achar os arquivos no projeto";
    const itens = {};
    const garantirClipe = async (nome, caminho) => {
      if (itens[nome]) return itens[nome];
      let achado = await acharClipe(ppro, projeto, caminho);
      if (!achado) { await projeto.importFiles([caminho]); await dormir(1500); achado = await acharClipe(ppro, projeto, caminho); }
      if (!achado) throw new Error("não achei " + nome + " no projeto");
      itens[nome] = achado;
      return achado;
    };
    for (const [nome, caminho] of Object.entries(cameras)) await garantirClipe(nome, caminho);

    const hora = new Date();
    const nome = "VERTICAL " + String(hora.getHours()).padStart(2, "0") + "h" + String(hora.getMinutes()).padStart(2, "0");
    let sequencia = null, editor = null;
    const usados = new Set();
    const trilhas = {};
    const totalPecas = camerasOrdem.length * pecas.length;
    let feitas = 0;
    // cada câmera fica na sua própria trilha (V1, V2, V3), cortada nos mesmos pontos da sequência original;
    // só a câmera ativa em cada trecho fica ligada, as outras ficam DESATIVADAS (nada é apagado)
    for (let ci = 0; ci < camerasOrdem.length; ci++) {
      const cam = camerasOrdem[ci];
      const alvo = itens[cam];
      for (let i = 0; i < pecas.length; i++) {
        const p = pecas[i];
        feitas++;
        mostrar("Montando o vídeo vertical (" + cam + "): peça " + feitas + " de " + totalPecas + "\nNão mexa no Premiere.");
        etapa = "definir entrada/saída da peça " + feitas + " (" + cam + ")";
        const tIni = await ppro.TickTime.createWithSeconds(p.arq[cam][0]);
        const tFim = await ppro.TickTime.createWithSeconds(p.arq[cam][1]);
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

    // desativa os pedaços das câmeras que não são as ativas
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

    // áudio: copia, trilha por trilha, o que já está na sequência original (mesmos cortes), depois das trilhas de áudio das câmeras
    etapa = "copiar o áudio da sequência";
    const baseA = camerasOrdem.length;
    const mudas = [];
    const arquivosCamera = new Set(Object.values(cameras));
    const nAseq = await origem.getAudioTrackCount();
    let feitasA = 0;
    for (let ai = 0; ai < nAseq; ai++) {
      const lista = (await lerFaixa("A", ai)).filter((c) => c.caminho && !arquivosCamera.has(c.caminho));
      if (!lista.length) continue;
      let muda = false;
      try { const trO = await origem.getAudioTrack(ai); if (typeof trO.isMuted === "function") muda = !!(await trO.isMuted()); } catch (e) { muda = false; }
      if (muda) { mudas.push(baseA + ai); continue; } // trilha silenciada na original: não copia
      for (const c of lista) {
        if (c.des) continue;
        const a = Math.max(c.ini, INICIO), b = Math.min(c.fim, FIM);
        if (b - a < 0.04) continue;
        feitasA++;
        mostrar("Copiando o áudio (A" + (ai + 1) + "): trecho " + feitasA + "\nNão mexa no Premiere.");
        const ach = await garantirClipe("A:" + c.caminho, c.caminho);
        const fIni = await ppro.TickTime.createWithSeconds(c.entrada + (a - c.ini));
        const fFim = await ppro.TickTime.createWithSeconds(c.entrada + (b - c.ini));
        await executar(projeto, "Vertical: entrada e saída (áudio)", () => ach.clip.createSetInOutPointsAction(fIni, fFim));
        const tpos = await ppro.TickTime.createWithSeconds(a - INICIO);
        await executar(projeto, "Vertical: colocar áudio", () => editor.createOverwriteItemAction(ach.item, tpos, 0, baseA + ai));
      }
    }
    for (const c of usados) await executar(projeto, "Vertical: limpar", () => itens[c].clip.createClearInOutPointsAction());
    for (const k of Object.keys(itens)) if (k.indexOf("A:") === 0) await executar(projeto, "Vertical: limpar", () => itens[k].clip.createClearInOutPointsAction());
    try { // silencia o áudio das câmeras (o áudio bom vem dos microfones)
      for (let i = 0; i < baseA; i++) await (await sequencia.getAudioTrack(i)).setMute(true);
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
}

$("btnVertSeq").addEventListener("click", () => semPressa(() => fluxoVertical("seq")));
$("btnVertInOut").addEventListener("click", () => semPressa(() => fluxoVertical("inout")));

// --- Trechos com chance de viralizar: sugere, você escolhe e converte ---
async function arquivoParaSequencia(ppro, seq, wav) { // converte "tempo do arquivo de áudio" em "tempo da sequência"
  const sec = async (f) => { const t = await f(); return t && t.seconds !== undefined ? t.seconds : Number(t); };
  const nA = await seq.getAudioTrackCount();
  const alvo = String(wav).toLowerCase().replace(/\\/g, "/");
  for (let ai = 0; ai < nA; ai++) {
    const tr = await seq.getAudioTrack(ai);
    const its = await tr.getTrackItems(1, false);
    const lista = [];
    for (const it of its) {
      try {
        const cp = await ppro.ClipProjectItem.cast(await it.getProjectItem());
        const c = String(await cp.getMediaFilePath()).toLowerCase().replace(/\\/g, "/");
        if (c !== alvo) continue;
        lista.push({ ini: await sec(() => it.getStartTime()), fim: await sec(() => it.getEndTime()), entrada: await sec(() => it.getInPoint()) });
      } catch (e) { /* outro tipo de item */ }
    }
    if (!lista.length) continue;
    lista.sort((a, b) => a.ini - b.ini);
    return (f) => {
      for (const c of lista) if (f >= c.entrada - 0.001 && f <= c.entrada + (c.fim - c.ini) + 0.001) return c.ini + (f - c.entrada);
      const prox = lista.find((c) => c.entrada > f);
      if (prox) return prox.ini;
      const u = lista[lista.length - 1];
      return u.fim;
    };
  }
  return (f) => f; // não achei o áudio na sequência: assume que o tempo é o mesmo
}

let VIRAIS = [];
$("btnViral").addEventListener("click", () => semPressa(async () => {
  let etapa = "começando";
  try {
    const ppro = require("premierepro");
    const projeto = await ppro.Project.getActiveProject();
    const origem = await projeto.getActiveSequence();
    if (!origem) return mostrar("Nenhuma sequência ativa (deixe a PODCAST ativa).", true);
    etapa = "ler o áudio da sequência";
    const wav = await wavDoPodcast(ppro, origem);
    etapa = "procurar os melhores momentos";
    const [dmin, dmax] = String($("viralDur").value || "30-60").split("-").map(Number);
    const r = await comRelogio("Procurando os trechos com mais chance de prender...", () => chamar("/virais", { path: wav, min: dmin, max: dmax, quantidade: 8 }));
    VIRAIS = r.trechos || [];
    const caixa = $("viraisLista");
    while (caixa.firstChild) caixa.removeChild(caixa.firstChild);
    if (!VIRAIS.length) return mostrar("Não achei trechos nessa duração. Tente outra duração.", true);
    VIRAIS.forEach((v, i) => {
      const c = document.createElement("div"); c.className = "ed-card";
      const t = document.createElement("div"); t.className = "ed-tit"; t.textContent = (i + 1) + ") " + fmt(v.ini) + " a " + fmt(v.fim) + "  ·  nota " + v.nota;
      const tx = document.createElement("div"); tx.className = "dica"; tx.textContent = "“" + v.texto + "”";
      const mo = document.createElement("div"); mo.className = "dica"; mo.style.color = "#b9acff"; mo.textContent = v.motivos.join(" · ");
      const b = document.createElement("div"); b.className = "mini"; b.textContent = "📱 Converter este trecho em vertical";
      b.addEventListener("click", () => semPressa(async () => {
        try {
          const proj = await ppro.Project.getActiveProject();
          const seq = await proj.getActiveSequence();
          const mapa = await arquivoParaSequencia(ppro, seq, wav);
          await fluxoVertical("janela", { ini: mapa(v.ini), fim: mapa(v.fim) });
        } catch (e) { mostrar("Erro ao converter este trecho:\n" + (e && e.message ? e.message : e), true); }
      }));
      c.appendChild(t); c.appendChild(tx); c.appendChild(mo); c.appendChild(b);
      caixa.appendChild(c);
    });
    mostrar("Achei " + VIRAIS.length + " sugestões, da maior nota para a menor. Role a aba Vertical para vê-las e clique em Converter no trecho que gostar.");
  } catch (e) {
    mostrar("Erro ao " + etapa + ":\n" + (e && e.message ? e.message : e), true);
  }
}));



// --- Abas do painel ---------------------------------------------------------
(function () {
  const abas = ["Podcast", "Legendas", "Criativos", "Vertical", "Silencios", "Buscar", "Avancado"];
  const comTrecho = new Set([]);
  function abrir(nome) {
    abas.forEach((a) => {
      const conteudo = $(a);
      const botao = $("aba" + a);
      if (conteudo) conteudo.className = "aba" + (a === nome ? " visivel" : "");
      if (botao) botao.className = a === nome ? "pill ativa" : "pill";
    });
    const bloco = $("blocoTrecho");
    if (bloco) bloco.style.display = comTrecho.has(nome) ? "block" : "none";
    try { window.scrollTo(0, 0); document.documentElement.scrollTop = 0; document.body.scrollTop = 0; } catch (e) { /* segue */ } // aba nova começa no topo
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

const globalMostrar = (t, e) => { try { status.textContent = t; status.className = e ? "erro" : ""; } catch (x) { /* sem status */ } };
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
  const mostrar = (t, e) => { window.mostrarGlobal ? 0 : 0; $("msgAtual").textContent = t; $("msgAtual").style.color = e ? "#ff8a80" : "#9a9a9a"; globalMostrar(t, e); };
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


// --- Galeria de estilos de legenda (cartões com imagem) -------------------------------
(function () {
  const sel = $("estEstilo"), gal = $("galeria");
  if (!sel || !gal) return;
  const COM_IMAGEM = new Set(["Bold", "Classic", "Film", "Modern", "Simple", "Criativo 1", "Criativo 2", "Criativo 3", "Criativo 4"]);
  const PADRAO = ["aleatorio", "Criativo 1", "Criativo 2", "Criativo 3", "Criativo 4"];
  let favoritos = new Set(PADRAO);
  try { const s = localStorage.getItem("ppFavEstilos"); if (s) favoritos = new Set(JSON.parse(s)); } catch (e) { /* sem armazenamento */ }
  const salvar = () => { try { localStorage.setItem("ppFavEstilos", JSON.stringify(Array.from(favoritos))); } catch (e) { /* ignora */ } };
  let aberto = false;
  let assinatura = "";
  function cartao(o) {
    const card = document.createElement("div");
    card.className = "modelo" + (o.value === sel.value ? " sel" : "");
    if (COM_IMAGEM.has(o.value) || (window.ppEstilosImg && window.ppEstilosImg.has(o.value))) {
      const im = document.createElement("img");
      im.src = SERVICO + "/painel/img/" + o.value.replace(/ /g, "_") + ".png" + (window.ppVerImg ? "?v=" + window.ppVerImg : "");
      im.onerror = () => { const d = document.createElement("div"); d.className = "sem"; d.textContent = o.value; if (im.parentNode) im.parentNode.replaceChild(d, im); };
      card.appendChild(im);
    } else {
      const d = document.createElement("div"); d.className = "sem"; d.textContent = o.value === "aleatorio" ? "🎲 mistura" : "modelo"; card.appendChild(d);
    }
    const nome = document.createElement("div"); nome.className = "nome"; nome.textContent = o.textContent;
    const est = document.createElement("span"); est.className = "estrela" + (favoritos.has(o.value) ? " on" : "");
    est.textContent = favoritos.has(o.value) ? "★" : "☆"; est.title = favoritos.has(o.value) ? "Tirar dos favoritos" : "Adicionar aos favoritos";
    est.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (favoritos.has(o.value)) favoritos.delete(o.value); else favoritos.add(o.value);
      salvar(); assinatura = ""; desenhar();
    });
    nome.appendChild(est);
    card.appendChild(nome);
    card.addEventListener("click", () => { sel.value = o.value; assinatura = ""; desenhar(); try { if (window.ppEscolheuEstilo) window.ppEscolheuEstilo(o.value); } catch (e) { /* segue */ } });
    return card;
  }
  function desenhar() {
    const ops = Array.from(sel.options);
    const ass = ops.map((o) => o.value + "|" + o.textContent).join(";") + "#" + sel.value + "#" + Array.from(favoritos).join(",") + "#" + aberto + "#" + (window.ppVerImg || 0);
    if (ass === assinatura) return;
    assinatura = ass;
    gal.innerHTML = "";
    const fav = ops.filter((o) => favoritos.has(o.value));
    const meusE = window.ppEstilosImg || new Set();
    const demais = ops.filter((o) => !fav.includes(o)).sort((a, b) => (meusE.has(b.value) ? 1 : 0) - (meusE.has(a.value) ? 1 : 0)); // meus estilos salvos primeiro
    const caixaFav = document.createElement("div"); caixaFav.className = "favoritos";
    fav.forEach((o) => caixaFav.appendChild(cartao(o)));
    gal.appendChild(caixaFav);
    const atual = ops.find((o) => o.value === sel.value);
    if (atual && !favoritos.has(atual.value)) {
      const aviso = document.createElement("div"); aviso.className = "dica"; aviso.style.marginTop = "6px";
      aviso.textContent = "Estilo escolhido: " + atual.textContent + " (está nos modelos ocultos)";
      gal.appendChild(aviso);
    }
    if (demais.length) {
      const bt = document.createElement("div"); bt.className = "mini"; bt.style.width = "100%";
      bt.textContent = aberto ? "− Ocultar modelos" : "+ Modelos (" + demais.length + ")";
      bt.addEventListener("click", () => { aberto = !aberto; assinatura = ""; desenhar(); });
      gal.appendChild(bt);
      if (aberto) {
        const caixa = document.createElement("div"); caixa.className = "outros";
        demais.forEach((o) => caixa.appendChild(cartao(o)));
        gal.appendChild(caixa);
      }
    }
  }
  desenhar();
  setInterval(desenhar, 1200); // acompanha templates que forem adicionados à lista
})();


// ---- Teste: importar modelos de legenda guardados em projeto do Premiere e colocar na timeline ----
const MODELOS_TESTE = [
  ["Criativo 1", ["stories com", "LEGENDAS", "tutorial//como ativar?"]],
  ["Criativo 2", ["LEGENDAS", "criativas e", "ANIMADAS"]],
  ["Criativo 3", ["ONDE NÃO", "colocar"]],
  ["Criativo 4", ["Por que", "legendar", "vídeos", "para redes sociais?"]],
];
$("btnTesteModelo").addEventListener("click", async () => {
  const msg = (t, e) => { $("msgModelo").textContent = t; $("msgModelo").style.color = e ? "#ff8a80" : "#9a9a9a"; };
  let etapa = "começar";
  try {
    const ppro = require("premierepro");
    const projeto = await ppro.Project.getActiveProject();
    const sequencia = await projeto.getActiveSequence();
    if (!sequencia) return msg("Abra uma sequência primeiro.", true);
    const editor = await ppro.SequenceEditor.getEditor(sequencia);
    let t0 = 0;
    try { t0 = (await sequencia.getPlayerPosition()).seconds; } catch (e) { t0 = 0; }
    let feitos = 0;
    for (let i = 0; i < MODELOS_TESTE.length; i++) {
      const [nome, linhas] = MODELOS_TESTE[i];
      etapa = nome + ": preparar";
      const prep = await chamar("/modelo/preparar", { modelo: nome, linhas });
      etapa = nome + ": importar";
      await projeto.importSequences(prep.caminho, [ppro.Guid.fromString(prep.guid)]);
      await dormir(2000);
      const itens = await (await projeto.getRootItem()).getItems();
      const iguais = itens.filter((it) => it.name === prep.nome);
      if (!iguais.length) return msg(nome + ": a sequência importada não apareceu.", true);
      etapa = nome + ": colocar na timeline";
      const t = await ppro.TickTime.createWithSeconds(t0 + i * 6);
      await executar(projeto, "Modelo: colocar", () => editor.createOverwriteItemAction(iguais[iguais.length - 1], t, 2, 2));
      feitos++;
      msg("Colocados " + feitos + " de " + MODELOS_TESTE.length + "...");
    }
    msg("Pronto: " + feitos + " modelos na timeline (V3), um a cada 6 segundos, a partir do cursor.");
  } catch (e) {
    msg("Falhou em '" + etapa + "': " + (e && e.message ? e.message : e), true);
  }
});


// ---- Editar o texto de uma legenda Criativo (clipe selecionado na timeline) ----
(function () {
  const msg = (t, e) => { const m = $("msgEditLeg"); if (m) { m.textContent = t; m.style.color = e ? "#ff8a80" : "#9a9a9a"; } };
  const nomeArq = (c) => String(c).split(/[\\/]/).pop();
  async function selecionada() {
    const ppro = require("premierepro");
    const projeto = await ppro.Project.getActiveProject();
    const seq = await projeto.getActiveSequence();
    if (!seq) throw new Error("Abra a sequência primeiro.");
    const sel = await seq.getSelection();
    const itens = await sel.getTrackItems();
    if (!itens || !itens.length) throw new Error("Clique numa legenda na timeline primeiro.");
    const it = itens[0];
    const pi = await it.getProjectItem();
    const nome = pi.name;
    const ini = (await it.getStartTime()).seconds, fim = (await it.getEndTime()).seconds;
    let trilha = -1;
    const nV = await seq.getVideoTrackCount();
    for (let i = 0; i < nV && trilha < 0; i++) {
      const lista = await (await seq.getVideoTrack(i)).getTrackItems(1, false);
      for (const c of lista) {
        if (Math.abs((await c.getStartTime()).seconds - ini) < 0.02 && (await (await c.getProjectItem()).name) === nome) { trilha = i; break; }
      }
    }
    if (trilha < 0) throw new Error("Não achei a trilha desse clipe.");
    return { ppro, projeto, seq, nome, ini, fim, trilha };
  }
  $("btnLerLeg").addEventListener("click", async () => {
    try {
      const s = await selecionada();
      const info = await chamar("/legenda/info", { nome: s.nome });
      $("txtEditLeg").value = info.texto;
      msg("Texto carregado (" + info.estilo + "). Edite e clique em Aplicar.");
    } catch (e) { msg(e && e.message ? e.message : String(e), true); }
  });
  $("btnAplicarLeg").addEventListener("click", async () => {
    let etapa = "começar";
    try {
      const novo = $("txtEditLeg").value.trim();
      if (!novo) return msg("Escreva o texto novo.", true);
      const s = await selecionada();
      etapa = "ler o estilo da legenda";
      const info = await chamar("/legenda/info", { nome: s.nome });
      etapa = "desenhar a legenda nova";
      msg("Desenhando...");
      let LARG = 1920, ALT = 1080;
      try { const fs = await s.seq.getFrameSize(); if (fs && fs.width > 0) { LARG = fs.width; ALT = fs.height; } } catch (e) { /* padrão */ }
      const ov = await chamar("/legendas_overlay", {
        estilo: info.estilo, w: LARG, h: ALT, fps: 30, separado: true,
        blocos: [{ a: 0, b: Math.max(0.4, s.fim - s.ini), texto: novo }],
      });
      etapa = "importar";
      const nn = nomeArq(ov.itens[0].arquivo);
      const imp = await importarLegendas(s.ppro, s.projeto, [ov.itens[0].arquivo]);
      const item = imp.porNome.get(nn) || null;
      if (!item) throw new Error("o Premiere não importou a legenda nova");
      etapa = "trocar na timeline";
      const ed = await s.ppro.SequenceEditor.getEditor(s.seq);
      const t = await s.ppro.TickTime.createWithSeconds(s.ini);
      await executar(s.projeto, "Legenda: trocar texto", () => ed.createOverwriteItemAction(item, t, s.trilha, 0));
      let org = "";
      try { org = textoOrganizar(await organizarLegendas(s.ppro, s.projeto, true)); } catch (e) { /* opcional */ }
      msg("Pronto: legenda trocada. (Ctrl+Z desfaz.)" + org);
    } catch (e) { msg("Erro ao " + etapa + ": " + (e && e.message ? e.message : e), true); }
  });
})();


// ---- Corrigir o texto de TODAS as legendas Criativo de uma vez ----
(function () {
  const msg = (t, e) => { const m = $("msgTodasLeg"); if (m) { m.textContent = t; m.style.color = e ? "#ff8a80" : "#9a9a9a"; } };
  const nomeArq = (c) => String(c).split(/[\\/]/).pop();
  let lista = [];   // [{ nome, ini, fim, trilha, texto }]
  async function lerTodas() {
    const ppro = require("premierepro");
    const projeto = await ppro.Project.getActiveProject();
    const seq = await projeto.getActiveSequence();
    if (!seq) throw new Error("Abra a sequência primeiro.");
    const nV = await seq.getVideoTrackCount();
    const achados = [];
    for (let i = 0; i < nV; i++) {
      const itens = await (await seq.getVideoTrack(i)).getTrackItems(1, false);
      for (const c of itens) {
        const nome = (await (await c.getProjectItem()).name) || "";
        if (/^leg\d+_/.test(nome)) {
          achados.push({ nome, ini: (await c.getStartTime()).seconds, fim: (await c.getEndTime()).seconds, trilha: i, item: c });
        }
      }
    }
    achados.sort((a, b) => a.ini - b.ini);
    return { ppro, projeto, seq, achados };
  }
  const fmt = (t) => { const m = Math.floor(t / 60), sg = t - m * 60; return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0") + ":" + sg.toFixed(1).padStart(4, "0"); };
  let ctx = null;
  function desenharLista() {
    const c = $("listaLeg");
    c.innerHTML = "";
    lista.forEach((x, i) => {
      const lin = document.createElement("div"); lin.className = "lin"; lin.dataset.ini = x.ini.toFixed(2); lin.dataset.nome = x.nome || "";
      const tc = document.createElement("div"); tc.className = "tc"; tc.title = "Ir para este ponto da timeline";
      tc.innerHTML = fmt(x.ini) + "<br>" + fmt(x.fim);
      tc.addEventListener("click", async () => {
        try { await ctx.seq.setPlayerPosition(await ctx.ppro.TickTime.createWithSeconds(x.ini)); } catch (e) { msg("Não consegui mover o cursor: " + (e && e.message ? e.message : e), true); }
      });
      const tx = document.createElement("textarea"); tx.rows = 2; tx.className = "tx"; tx.value = x.atual; tx.disabled = !x.estilo || !!x.removido;
      const marcar = () => { lin.classList.toggle("mudou", !!x.novo || !!x.tempoMudou || x.atual.trim() !== x.texto); lin.classList.toggle("removida", !!x.removido); };
      tx.addEventListener("input", () => { x.atual = tx.value; marcar(); });
      marcar();
      const mais = document.createElement("div"); mais.className = "mais"; mais.textContent = "+";
      mais.title = "Dividir esta legenda: cria uma nova logo abaixo (ela ocupa a segunda metade do tempo)";
      mais.style.visibility = x.estilo ? "visible" : "hidden";
      mais.addEventListener("click", () => {
        if (x.fim - x.ini < 0.8) return msg("Essa legenda é curta demais para dividir.", true);
        const meio = Math.round(((x.ini + x.fim) / 2) * 100) / 100;
        const nova = { nome: "", ini: meio, fim: x.fim, trilha: x.trilha, texto: "", atual: "", estilo: x.estilo, novo: true };
        x.fim = meio; x.tempoMudou = true;
        lista.splice(i + 1, 0, nova);
        desenharLista();
        const campos = document.querySelectorAll("#listaLeg .tx");
        if (campos[i + 1]) campos[i + 1].focus();
        msg("Nova legenda criada abaixo. Escreva o texto e clique em Aplicar.");
      });
      const menos = document.createElement("div"); menos.className = "menos"; menos.textContent = x.removido ? "↺" : "−";
      menos.title = x.removido ? "Desfazer a exclusão" : "Excluir esta legenda";
      menos.style.visibility = x.estilo ? "visible" : "hidden";
      menos.addEventListener("click", () => {
        if (x.novo) {  // legenda criada agora: some e devolve o tempo para a anterior
          const ant = lista[i - 1];
          if (ant && Math.abs(ant.fim - x.ini) < 0.02) ant.fim = x.fim;
          lista.splice(i, 1);
        } else x.removido = !x.removido;
        desenharLista();
        msg(x.removido ? "Legenda marcada para excluir. Clique em Aplicar." : "Ok.");
      });
      lin.appendChild(tc); lin.appendChild(tx); lin.appendChild(mais); lin.appendChild(menos); c.appendChild(lin);
    });
  }
  async function carregar() {
    msg("Lendo as legendas...");
    const s = await lerTodas();
    ctx = s;
    if (!s.achados.length) { lista = []; desenharLista(); return msg("Não achei legendas Criativo nessa sequência.", true); }
    const r = await chamar("/legenda/info_lote", { nomes: s.achados.map((a) => a.nome) });
    const semTexto = r.infos.filter((x) => !x).length;
    lista = s.achados.map((a, i) => { const t = r.infos[i] ? r.infos[i].texto : ""; return { ...a, texto: t, atual: t, estilo: r.infos[i] ? r.infos[i].estilo : null }; });
    desenharLista();
    msg(lista.length + " legendas carregadas." + (semTexto ? " " + semTexto + " sem texto guardado (feitas por versão antiga): não serão alteradas." : "") + " Corrija e clique em Aplicar. Use o + para dividir uma legenda em duas.");
  }
  $("btnLerTodas").addEventListener("click", async () => {
    try { await carregar(); } catch (e) { msg(e && e.message ? e.message : String(e), true); }
  });
  $("btnAplicarTodas").addEventListener("click", async () => {
    let etapa = "começar";
    try {
      if (!lista.length) return msg("Clique primeiro em Carregar.", true);
      const linhas = lista.map((x) => x.atual);
      if (lista.some((x) => x.novo && !x.removido && !x.atual.trim())) return msg("Escreva o texto de todas as legendas novas (linhas roxas vazias) antes de aplicar.", true);
      const mudadas = [];
      lista.forEach((x, i) => { const n = x.atual.trim(); if (x.estilo && !x.removido && n && (x.novo || x.tempoMudou || n !== x.texto)) mudadas.push(i); });
      const removidas = lista.filter((x) => x.removido && !x.novo);
      if (!mudadas.length && !removidas.length) return msg("Nenhuma linha foi alterada.");
      etapa = "desenhar as legendas";
      msg("Desenhando " + mudadas.length + " legenda(s)...");
      const s = await lerTodas();
      // confere que a linha do clipe continua sendo o mesmo clipe (nome e início)
      const mapa = new Map(s.achados.map((a) => [a.nome + "@" + a.ini.toFixed(2), a]));
      let LARG = 1920, ALT = 1080;
      try { const fs = await s.seq.getFrameSize(); if (fs && fs.width > 0) { LARG = fs.width; ALT = fs.height; } } catch (e) { /* padrão */ }
      const porEstilo = {};
      for (const i of mudadas) (porEstilo[lista[i].estilo] = porEstilo[lista[i].estilo] || []).push(i);
      const novos = new Map(); // índice -> arquivo
      for (const est of Object.keys(porEstilo)) {
        const idx = porEstilo[est];
        const ov = await chamar("/legendas_overlay", {
          estilo: est, w: LARG, h: ALT, fps: 30, separado: true,
          blocos: idx.map((i, k) => ({ a: k * 10, b: k * 10 + Math.max(0.4, lista[i].fim - lista[i].ini), texto: linhas[i].trim() })),
        });
        ov.itens.forEach((x, k) => novos.set(idx[k], x.arquivo));
      }
      etapa = "importar as legendas novas";
      const { porNome } = await importarLegendas(s.ppro, s.projeto, Array.from(novos.values()));
      const ed = await s.ppro.SequenceEditor.getEditor(s.seq);
      let feitas = 0;
      const falhas = [];
      for (const [i, arq] of novos) {
        const item = porNome.get(nomeArq(arq));
        const alvo = lista[i].novo ? { ini: lista[i].ini, trilha: lista[i].trilha } : mapa.get(lista[i].nome + "@" + lista[i].ini.toFixed(2));
        if (!item || !alvo) { falhas.push(i + 1); continue; }
        etapa = "trocar a legenda " + (i + 1);
        const t = await s.ppro.TickTime.createWithSeconds(alvo.ini);
        await executar(s.projeto, "Legenda: corrigir texto", () => ed.createOverwriteItemAction(item, t, alvo.trilha, 0));
        feitas++;
        if (feitas % 5 === 0) msg("Trocando as legendas: " + feitas + " de " + novos.size + "...");
      }
      // atualiza a lista com os novos nomes/textos: peça para carregar de novo
      let excluidas = 0;
      if (removidas.length) {
        etapa = "excluir as legendas marcadas";
        try {
          const sel = await s.seq.createEmptySelection();
          for (const r of removidas) {
            const alvo = mapa.get(r.nome + "@" + r.ini.toFixed(2));
            if (alvo && alvo.item) { await sel.addItem(alvo.item, true); excluidas++; }
          }
          await executar(s.projeto, "Legenda: excluir", () => ed.createRemoveItemsAction(sel, false, s.ppro.Constants.MediaType.VIDEO));
        } catch (e) { falhas.push("exclusão: " + (e && e.message ? e.message : e) + " (apague na timeline com a tecla Delete)"); excluidas = 0; }
      }
      await dormir(1500);
      let org = "";
      try { org = textoOrganizar(await organizarLegendas(s.ppro, s.projeto, true)); } catch (e) { /* opcional */ }
      let aviso = "";
      try { await carregar(); } catch (e) { aviso = " (não consegui recarregar a lista: clique em Todas as legendas)"; }
      msg("Pronto: " + feitas + " legenda(s) corrigida(s)" + (excluidas ? ", " + excluidas + " excluída(s)" : "") + "." + (falhas.length ? " Não trocadas (linhas): " + falhas.join(", ") + " (o clipe foi movido; carregue de novo)." : "") + " A lista foi recarregada. (Ctrl+Z desfaz.)" + org + aviso);
    } catch (e) { msg("Erro ao " + etapa + ": " + (e && e.message ? e.message : e), true); }
  });
})();


// ---- Ao clicar numa legenda Criativo na timeline, o texto já aparece no painel ----
(function () {
  let ultima = "";
  let ocupado = false;
  const aba = () => { const e = $("txtEditLeg"); return e && e.offsetParent !== null; };
  async function olhar() {
    if (ocupado || !aba()) return;
    ocupado = true;
    try {
      const ppro = require("premierepro");
      const projeto = await ppro.Project.getActiveProject();
      const seq = projeto && (await projeto.getActiveSequence());
      if (!seq) return;
      const sel = await seq.getSelection();
      const itens = await sel.getTrackItems();
      if (!itens || !itens.length) { ultima = ""; return; }
      const it = itens[0];
      const nome = (await (await it.getProjectItem()).name) || "";
      if (!/^leg\d+_/.test(nome)) return;
      const ini = (await it.getStartTime()).seconds;
      const chave = nome + "@" + ini.toFixed(2);
      if (chave === ultima) return;
      ultima = chave;
      let info = null;
      try { info = await chamar("/legenda/info", { nome }); } catch (e) { info = null; }
      const campo = $("txtEditLeg");
      if (info && $("areaTodas").style.display !== "block" && window.abrirEdicaoLegenda) window.abrirEdicaoLegenda("uma");
      if (info && campo) { campo.value = info.texto; const m = $("msgEditLeg"); if (m) { m.textContent = "Legenda selecionada (" + info.estilo + "). Edite o texto e clique em Aplicar."; m.style.color = "#9a9a9a"; } }
      // lista completa: carrega sozinha na primeira vez e destaca a linha da legenda clicada
      if (!document.querySelector("#listaLeg .lin") && $("areaTodas").style.display === "block") { $("btnLerTodas").click(); await dormir(2500); }
      document.querySelectorAll("#listaLeg .lin").forEach((l) => {
        const eh = l.dataset.nome === nome && l.dataset.ini === ini.toFixed(2);
        l.style.outline = eh ? "2px solid #7c4dff" : "";
        if (eh) l.scrollIntoView({ block: "nearest" });
      });
    } catch (e) { /* sem seleção ou sem sequência: ignora */ }
    finally { ocupado = false; }
  }
  setInterval(olhar, 900);
})();


// ---- Editar legendas: dois botões coloridos que abrem a área de edição correspondente ----
(function () {
  const uma = $("areaUma"), todas = $("areaTodas"), bUma = $("btnLerLeg"), bTodas = $("btnLerTodas");
  if (!uma || !todas) return;
  window.abrirEdicaoLegenda = (qual) => {
    uma.style.display = qual === "uma" ? "block" : "none";
    todas.style.display = qual === "todas" ? "block" : "none";
    bUma.classList.toggle("ativo", qual === "uma");
    bTodas.classList.toggle("ativo", qual === "todas");
  };
  bUma.addEventListener("click", () => window.abrirEdicaoLegenda("uma"));
  bTodas.addEventListener("click", () => window.abrirEdicaoLegenda("todas"));
})();


// ---- Botão para voltar ao topo (aparece ao rolar para baixo, em qualquer aba) ----
(function () {
  const b = $("btnTopo");
  if (!b) return;
  const pos = () => Math.max(window.scrollY || 0, document.documentElement.scrollTop || 0, document.body.scrollTop || 0);
  const atualizar = () => {
    const p = pos();
    const alt = window.innerHeight || document.documentElement.clientHeight || 400;
    b.style.top = Math.round(p + alt - 56) + "px";   // acompanha a rolagem (sem position: fixed)
    b.classList.toggle("vis", p > 150);
  };
  window.addEventListener("scroll", atualizar, true);
  window.addEventListener("resize", atualizar);
  setInterval(atualizar, 400);
  b.addEventListener("click", () => {
    try { window.scrollTo(0, 0); } catch (e) { /* ignora */ }
    document.documentElement.scrollTop = 0; document.body.scrollTop = 0;
    setTimeout(atualizar, 50);
  });
})();

(function () {
  const c = $("carregando");
  if (c) c.addEventListener("click", () => { try { status.scrollIntoView(); } catch (e) { try { window.scrollTo(0, 100000); } catch (x) { /* segue */ } } });
})();

// "Concluir": recolhe a seção; se ela foi aberta no meio de uma montagem, monta de novo já com os ajustes.
(function () {
  const b = $("btnConcluirPartic");
  if (!b) return;
  b.addEventListener("click", () => {
    recolherParticipantes();
    try { window.scrollTo(0, 0); } catch (e) { /* segue */ }
    const montar = AJUSTE_PEDIDO;
    AJUSTE_PEDIDO = false;
    LISTA_CONFIRMADA = true;
    b.textContent = "✔ Concluir";
    if (montar) semPressa(fluxoPodcastCompleto);
    else mostrar("Participantes salvos. Clique em \"Montar podcast completo\" quando quiser.");
  });
})();

// versão atual ao lado do nome do painel
(async function () {
  try {
    const r = await fetch(SERVICO + "/ping");
    const d = await r.json();
    if ($("verPainel") && d && d.versao) $("verPainel").textContent = "v" + d.versao;
  } catch (e) { /* programa local ainda iniciando */ }
})();

// Botão: organiza o que já está no projeto (move as soltas para a pasta e tira as não usadas)
(function () {
  const b = $("btnOrganizarLeg");
  if (!b) return;
  b.addEventListener("click", () => semPressa(async () => {
    const m = $("msgOrgLeg");
    try {
      const ppro = require("premierepro");
      const projeto = await ppro.Project.getActiveProject();
      if (m) m.textContent = "Organizando...";
      const r = await organizarLegendas(ppro, projeto, true);
      const txt = textoOrganizar(r).trim() || "Nada para organizar: as legendas já estão na pasta e em uso.";
      if (m) m.textContent = txt;
      mostrar(txt);
    } catch (e) { if (m) m.textContent = "Erro: " + (e && e.message ? e.message : e); mostrar("Erro ao organizar as legendas: " + (e && e.message ? e.message : e), true); }
  }));
})();

// Menu "Avançado" da aba Legendas (abre e fecha)
(function () {
  const m = $("menuLegAv");
  if (!m) return;
  m.addEventListener("click", () => {
    const aberto = $("corpoLegAv").style.display !== "none";
    $("corpoLegAv").style.display = aberto ? "none" : "block";
    $("setaLegAv").textContent = aberto ? "▸" : "▾";
  });
})();

// ===================== Criador de estilos de legenda =====================
(function () {
  const botao = $("btnCriarEstilo"), caixa = $("criador"), sel = $("estEstilo");
  if (!botao || !caixa) return;
  window.ppEstilosImg = window.ppEstilosImg || new Set();
  const CORES = ["#FFFFFF", "#E0E0E0", "#9E9E9E", "#555555", "#000000", "#FFD700", "#FFB000", "#FF8A00", "#FF5A36", "#FF1744", "#B71C1C", "#FF28C8",
    "#E040FB", "#B09CFF", "#7C4DFF", "#3D5AFE", "#2979FF", "#00B0FF", "#00E5FF", "#1DE9B6", "#7CFF6B", "#C6FF00", "#00C853", "#795548"];
  const ANIMS = [["pop", "Pulo (aparece crescendo)"], ["fade", "Surgir suave"], ["subir", "Subir"], ["descer", "Descer"],
                 ["zoom", "Zoom (de perto para o normal)"], ["quicar", "Quicar"], ["digitar", "Digitar (letra por letra)"], ["nenhuma", "Sem animação"]];
  let fontes = [], estilos = [], E = null, timerPrevia = null, aberto = false;

  const hex2rgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h).trim()); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const rgb2hex = (c) => "#" + (c || [255, 255, 255]).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("").toUpperCase();
  const linhaPadrao = (i) => ({ f: "Poppins-Bold", tam: 8, y: Math.min(90, 40 + i * 14), x: 50, cor: "#FFFFFF", caixa: false, rot: 0,
    contorno: { on: false, cor: "#000000", larg: 6 }, sombra: { on: true, forca: 65 },
    tarja: { on: false, cor: "#000000", opac: 75, raio: 25 }, brilho: { on: false, cor: "#FFD700", forca: 80 } });

  function doDef(def) { // definição do servidor -> estado do editor
    return {
      linhas: def.linhas.map((l) => ({
        f: l.f, tam: Math.round(l.tam * 1000) / 10, y: Math.round(l.y * 100), x: Math.round((l.x === undefined ? 0.5 : l.x) * 100),
        cor: rgb2hex(l.cor), caixa: !!l.caixa, rot: l.rot || 0,
        contorno: l.contorno && l.contorno.ligada !== false ? { on: true, cor: rgb2hex(l.contorno.cor || [0, 0, 0]), larg: Math.round((l.contorno.larg || 0.06) * 100) } : { on: false, cor: "#000000", larg: 6 },
        sombra: l.sombra && l.sombra.ligada === false ? { on: false, forca: 65 } : { on: true, forca: Math.round(((l.sombra && l.sombra.opac) || 0.65) * 100) },
        tarja: l.tarja && l.tarja.ligada !== false ? { on: true, cor: rgb2hex(l.tarja.cor || [0, 0, 0]), opac: Math.round((l.tarja.opac === undefined ? 0.75 : l.tarja.opac) * 100), raio: Math.round((l.tarja.raio || 0.25) * 100) } : { on: false, cor: "#000000", opac: 75, raio: 25 },
        brilho: l.brilho && l.brilho.ligada !== false ? { on: true, cor: rgb2hex(l.brilho.cor || l.cor), forca: Math.round((l.brilho.forca === undefined ? 0.8 : l.brilho.forca) * 100) } : { on: false, cor: "#FFD700", forca: 80 },
      })),
      anim: Object.assign({ entrada: "pop", duracao: 0.28, atraso: 0.07, saida: "fade" }, def.anim || {}),
    };
  }
  function ordenarPorProfundidade(d, def) { // a lista do editor segue a profundidade (de cima = na frente)
    d.linhas.forEach((l, i) => { l.uid = i; });
    const pil = def.anim && def.anim.pilha;
    if (Array.isArray(pil) && pil.length === d.linhas.length) d.linhas = d.linhas.map((l, i) => [pil[i], l]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    return d;
  }
  function ordemEntrada() { // ordem em que as linhas aparecem na animação (não muda ao reordenar a profundidade)
    E.linhas.forEach((l, i) => { if (l.uid === undefined) l.uid = 100 + i; });
    return E.linhas.slice().sort((a, b) => a.uid - b.uid);
  }
  function paraDef() { // estado -> definição para o servidor
    return {
      linhas: ordemEntrada().map((l) => {
        const o = { f: l.f, tam: l.tam / 100, y: l.y / 100, x: l.x / 100, cor: hex2rgb(l.cor) || [255, 255, 255], caixa: l.caixa, rot: l.rot };
        if (l.contorno.on) o.contorno = { cor: hex2rgb(l.contorno.cor) || [0, 0, 0], larg: l.contorno.larg / 100 };
        o.sombra = l.sombra.on ? { opac: l.sombra.forca / 100 } : { ligada: false };
        if (l.tarja.on) o.tarja = { cor: hex2rgb(l.tarja.cor) || [0, 0, 0], opac: l.tarja.opac / 100, raio: l.tarja.raio / 100, pad: 0.25 };
        if (l.brilho.on) o.brilho = { cor: hex2rgb(l.brilho.cor) || [255, 215, 0], forca: l.brilho.forca / 100, raio: 0.25 };
        return o;
      }),
      anim: E.anim,
    };
  }
  let ULTIMA_PREVIA = "";
  function destaqueIdx() { // posições (na ordem de entrada) das linhas marcadas, para a moldura na prévia
    const marc = (E.marc || []).map((m) => E.linhas[m]).filter(Boolean);
    const alvo = marc.length ? marc : (E.sel >= 0 && E.linhas[E.sel] ? [E.linhas[E.sel]] : []);
    const ordem = ordemEntrada();
    return alvo.map((l) => ordem.indexOf(l)).filter((k) => k >= 0);
  }
  function agendarPrevia(semReiniciar) {
    if (MODO_CRIATIVO) { agendarPreviaC(); return; }
    if (semReiniciar && timerPrevia) return; // durante o arraste/segurar, atualiza a cada 250 ms
    if (timerPrevia) clearTimeout(timerPrevia);
    timerPrevia = setTimeout(async () => {
      timerPrevia = null;
      try {
        const rp = await chamar("/estilo/previa", { def: paraDef(), formato: E.formato || "h", guias: !!E.guias });
        if (!ARRASTE) { E.caixas = rp.caixas || []; montarMolduras(); }
        const im = $("edPrevia");
        ULTIMA_PREVIA = SERVICO + "/painel/img/prev_editor.png?t=" + Date.now();
        if (im) { im.src = ULTIMA_PREVIA; ajustarPalco("edMoldura", "edPrevia", "edOverlay"); setTimeout(() => { ajustarPalco("edMoldura", "edPrevia", "edOverlay"); montarMolduras(); }, 120); }
      } catch (e) { const m = $("edMsg"); if (m) m.textContent = "Prévia: " + (e && e.message ? e.message : e); }
    }, 250);
  }

  // ---- seleção direto na prévia: moldura em volta das linhas marcadas, arrastar para mover, cantos para mudar o tamanho ----
  let ARRASTE = null;
  const geoPrevia = () => {
    const im = $("edPrevia"); if (!im || !im.offsetWidth) return null;
    const w = im.offsetWidth, vert = im.getAttribute("data-vert") === "1";
    return { w, h: w * (vert ? 16 / 9 : 9 / 16) };
  };
  const linhasSelecionadas = () => {
    const m = (E.marc || []).map((i) => E.linhas[i]).filter(Boolean);
    return m.length ? m : (E.sel >= 0 && E.linhas[E.sel] ? [E.linhas[E.sel]] : []);
  };
  function montarMolduras() {
    const ov = $("edOverlay"), g = geoPrevia();
    if (!ov || !g || !E) return;
    ov.innerHTML = "";
    const ord = ordemEntrada(), sel = linhasSelecionadas();
    (E.caixas || []).forEach((cx) => {
      const l = ord[cx.k];
      if (!l || sel.indexOf(l) < 0) return;
      const x0 = cx.x0 * g.w - 4, y0 = cx.y0 * g.h - 4, x1 = cx.x1 * g.w + 4, y1 = cx.y1 * g.h + 4;
      const fr = el("div"); fr.style.position = "absolute"; fr.style.left = Math.round(x0) + "px"; fr.style.top = Math.round(y0) + "px";
      fr.style.width = Math.max(4, Math.round(x1 - x0)) + "px"; fr.style.height = Math.max(4, Math.round(y1 - y0)) + "px";
      fr.style.border = "2px solid #ffd60a"; fr.style.boxSizing = "border-box";
      ov.appendChild(fr);
      for (const [qx, qy] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
        const h = el("div"); h.style.position = "absolute"; h.style.width = "10px"; h.style.height = "10px"; h.style.left = Math.round(qx - 5) + "px"; h.style.top = Math.round(qy - 5) + "px";
        h.style.backgroundColor = "#ffffff"; h.style.border = "2px solid #ffd60a"; h.style.boxSizing = "border-box";
        ov.appendChild(h);
      }
    });
  }
  function aoApertarPrevia(ev) {
    const g = geoPrevia(), ov = $("edOverlay"); if (!g || !ov || !E) return;
    try { ev.preventDefault(); } catch (e) { /* segue */ }
    const r = ov.getBoundingClientRect(), px = ev.clientX - r.left, py = ev.clientY - r.top;
    const ord = ordemEntrada(); let sel = linhasSelecionadas();
    const caixaDe = (l) => (E.caixas || []).find((c) => ord[c.k] === l);
    let modo = null, ref = null;
    for (const l of sel) { // cantos das linhas selecionadas = mudar tamanho
      const c = caixaDe(l); if (!c) continue;
      for (const [qx, qy] of [[c.x0, c.y0], [c.x1, c.y0], [c.x0, c.y1], [c.x1, c.y1]]) {
        if (Math.abs(px - qx * g.w) <= 11 && Math.abs(py - qy * g.h) <= 11) { modo = "escala"; ref = c; break; }
      }
      if (modo) break;
    }
    if (!modo) { // clicou numa linha? (a da frente primeiro)
      let achou = null;
      for (const l of E.linhas) {
        const c = caixaDe(l); if (!c) continue;
        if (px >= c.x0 * g.w - 6 && px <= c.x1 * g.w + 6 && py >= c.y0 * g.h - 6 && py <= c.y1 * g.h + 6) { achou = l; break; }
      }
      if (!achou) { E.marc = []; montarMolduras(); desenhar(); agendarPrevia(); return; }
      if (sel.indexOf(achou) < 0) { E.marc = [E.linhas.indexOf(achou)]; sel = [achou]; montarMolduras(); }
      modo = "mover";
    }
    const alvos = sel.map((l) => { const c = caixaDe(l); return { l, c, c0: c ? { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 } : null, x0: l.x, y0: l.y, tam0: l.tam }; });
    const centro = ref ? { x: (ref.x0 + ref.x1) / 2 * g.w, y: (ref.y0 + ref.y1) / 2 * g.h } : null;
    ARRASTE = { modo, g, px0: px, py0: py, alvos, centro, r0: centro ? Math.max(8, Math.hypot(px - centro.x, py - centro.y)) : 1, ov };
    document.addEventListener("mousemove", aoMoverPrevia);
    document.addEventListener("mouseup", aoSoltarPrevia);
  }
  function aoMoverPrevia(ev) {
    const A = ARRASTE; if (!A) return;
    const r = A.ov.getBoundingClientRect(), px = ev.clientX - r.left, py = ev.clientY - r.top;
    if (A.modo === "mover") {
      for (const a of A.alvos) {
        a.l.x = Math.max(5, Math.min(95, Math.round(a.x0 + (px - A.px0) / A.g.w * 100)));
        a.l.y = Math.max(5, Math.min(95, Math.round(a.y0 + (py - A.py0) / A.g.h * 100)));
        if (a.c) { const dx = (a.l.x - a.x0) / 100, dy = (a.l.y - a.y0) / 100; a.c.x0 = a.c0.x0 + dx; a.c.x1 = a.c0.x1 + dx; a.c.y0 = a.c0.y0 + dy; a.c.y1 = a.c0.y1 + dy; }
      }
    } else {
      const f = Math.max(0.2, Math.min(6, Math.hypot(px - A.centro.x, py - A.centro.y) / A.r0));
      for (const a of A.alvos) {
        a.l.tam = Math.max(2, Math.min(30, Math.round(a.tam0 * f * 2) / 2));
        if (a.c) {
          const fr = a.l.tam / a.tam0, cx = (a.c0.x0 + a.c0.x1) / 2, cy = (a.c0.y0 + a.c0.y1) / 2, hw = (a.c0.x1 - a.c0.x0) / 2 * fr, hh = (a.c0.y1 - a.c0.y0) / 2 * fr;
          a.c.x0 = cx - hw; a.c.x1 = cx + hw; a.c.y0 = cy - hh; a.c.y1 = cy + hh;
        }
      }
    }
    montarMolduras();
    agendarPrevia(true);
  }
  function aoSoltarPrevia() {
    document.removeEventListener("mousemove", aoMoverPrevia);
    document.removeEventListener("mouseup", aoSoltarPrevia);
    if (!ARRASTE) return;
    ARRASTE = null;
    desenhar(); agendarPrevia();
  }

  // ---- componentes ----
  function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; }
  // controle numérico: barra de rolagem + caixinha com o número (dá para arrastar ou digitar)
  function stepper(obj, chave, min, max, passo, sufixo, casas) {
    const w = el("div", "stp");
    // barra própria (o controle nativo do Premiere pula para as pontas)
    const barra = el("div"); barra.style.width = "120px"; barra.style.height = "20px"; barra.style.position = "relative"; barra.style.flexShrink = "0";
    const trilho = el("div"); trilho.style.position = "absolute"; trilho.style.left = "0px"; trilho.style.right = "0px"; trilho.style.top = "9px"; trilho.style.height = "3px"; trilho.style.backgroundColor = "#555566"; trilho.style.borderRadius = "2px";
    const preench = el("div"); preench.style.position = "absolute"; preench.style.left = "0px"; preench.style.top = "9px"; preench.style.height = "3px"; preench.style.backgroundColor = "#7b61ff"; preench.style.borderRadius = "2px";
    const bola = el("div"); bola.style.position = "absolute"; bola.style.top = "3px"; bola.style.width = "14px"; bola.style.height = "14px"; bola.style.borderRadius = "7px"; bola.style.backgroundColor = "#e6e6f0";
    barra.appendChild(trilho); barra.appendChild(preench); barra.appendChild(bola);
    const posicionar = (v) => {
      const f = max > min ? (v - min) / (max - min) : 0;
      const x = Math.max(0, Math.min(1, f)) * 106;
      bola.style.left = x + "px"; preench.style.width = (x + 7) + "px";
    };
    posicionar(obj[chave]);
    const caixaNum = document.createElement("input");
    caixaNum.type = "text"; caixaNum.style.width = "52px"; caixaNum.style.height = "26px"; caixaNum.style.marginLeft = "6px"; caixaNum.style.textAlign = "center";
    const fmt = (v) => Number(v).toFixed(casas || 0).replace(".", ",");
    caixaNum.value = fmt(obj[chave]);
    const aplicar = (v) => { obj[chave] = Math.max(min, Math.min(max, Math.round(v * 1000) / 1000)); agendarPrevia(); };
    const doMouse = (ev) => {
      const r = barra.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (ev.clientX - r.left - 7) / Math.max(1, r.width - 14)));
      let v = min + f * (max - min);
      v = Math.round(v / passo) * passo;
      aplicar(v); caixaNum.value = fmt(obj[chave]); posicionar(obj[chave]);
    };
    let arrastando = false;
    barra.addEventListener("mousedown", (ev) => { arrastando = true; doMouse(ev); });
    document.addEventListener("mousemove", (ev) => { if (arrastando) doMouse(ev); });
    document.addEventListener("mouseup", () => { arrastando = false; });
    caixaNum.addEventListener("change", () => {
      const v = parseFloat(String(caixaNum.value).replace(",", "."));
      if (isFinite(v)) { aplicar(v); posicionar(obj[chave]); }
      caixaNum.value = fmt(obj[chave]);
    });
    w.appendChild(barra); w.appendChild(caixaNum);
    if (sufixo) { const sf = el("div", "v", sufixo.trim()); sf.style.width = "20px"; sf.style.marginLeft = "3px"; w.appendChild(sf); }
    return w;
  }
  function linha(rotulo, controle) { const r = el("div", "ed-lin"); r.appendChild(el("div", "rt", rotulo)); r.appendChild(controle); return r; }
  // botão redondo liga/desliga: círculo com uma bolinha dentro quando está ligado
  function bolinha(ligado, aoClicar) {
    const c = el("div"); c.style.width = "18px"; c.style.height = "18px"; c.style.borderRadius = "9px"; c.style.display = "flex"; c.style.alignItems = "center"; c.style.justifyContent = "center"; c.style.cursor = "pointer"; c.style.marginRight = "6px";
    const pintar = (on) => { c.style.border = "2px solid " + (on ? "#7b61ff" : "#8a8a9c"); c.innerHTML = ""; if (on) { const d = el("div"); d.style.width = "8px"; d.style.height = "8px"; d.style.borderRadius = "4px"; d.style.backgroundColor = "#7b61ff"; c.appendChild(d); } };
    let on = !!ligado; pintar(on);
    c.addEventListener("click", () => { on = !on; pintar(on); aoClicar(on); });
    return c;
  }
  function simNao(obj, chave, aoMudar) {
    return bolinha(obj[chave], (on) => { obj[chave] = on; if (aoMudar) aoMudar(); agendarPrevia(); });
  }
  function campoCor(obj, chave) {
    const w = el("div");
    const topo = el("div"); topo.style.display = "flex"; topo.style.alignItems = "center";
    const i = document.createElement("input"); i.type = "text"; i.value = obj[chave]; i.style.width = "100px"; i.style.height = "26px";
    const aplicarCor = (c) => { obj[chave] = c; i.value = c; amostra.style.backgroundColor = c; agendarPrevia(); };
    const amostra = el("div"); amostra.style.width = "26px"; amostra.style.height = "26px"; amostra.style.borderRadius = "13px"; amostra.style.border = "1px solid #77778a"; amostra.style.marginLeft = "8px"; amostra.style.backgroundColor = obj[chave];
    i.addEventListener("change", () => { if (hex2rgb(i.value)) aplicarCor("#" + i.value.replace("#", "").toUpperCase()); else i.value = obj[chave]; });
    // conta-gotas: pega a cor de qualquer lugar da tela (clique na cor desejada; Esc cancela)
    const gota = el("div", "ed-btn"); gota.style.margin = "0 0 0 8px"; gota.style.padding = "3px 8px"; gota.style.width = "auto";
    const icone = document.createElement("img"); icone.src = SERVICO + "/icone/conta_gotas.png"; icone.style.width = "22px"; icone.style.height = "22px";
    gota.appendChild(icone);
    let ativo = null;
    const parar = () => { if (ativo) { clearInterval(ativo.t); ativo = null; chamar("/cor_tela", { modo: "fim" }).catch(() => {}); } gota.style.backgroundColor = ""; };
    gota.addEventListener("click", () => {
      if (ativo) { parar(); i.value = obj[chave]; amostra.style.backgroundColor = obj[chave]; return; }
      gota.style.backgroundColor = "#6a58e0";
      chamar("/cor_tela", { modo: "inicio" }).catch(() => {});
      const est = { viuSolto: false, ocupado: false, inicio: Date.now(), t: null };
      ativo = est;
      est.t = setInterval(async () => {
        if (est.ocupado) return; est.ocupado = true;
        try {
          const r = await chamar("/cor_tela", {});
          if (ativo !== est) return;
          amostra.style.backgroundColor = r.cor; i.value = r.cor;
          if (r.esc || Date.now() - est.inicio > 60000) { parar(); i.value = obj[chave]; amostra.style.backgroundColor = obj[chave]; }
          else if (!r.clicando) est.viuSolto = true;
          else if (est.viuSolto) { parar(); aplicarCor(r.cor); }
        } catch (e) { parar(); i.value = obj[chave]; const m = $("edMsg"); if (m) m.textContent = "Conta-gotas: " + (e && e.message ? e.message : e); }
        est.ocupado = false;
      }, 90);
    });
    topo.appendChild(i); topo.appendChild(amostra); topo.appendChild(gota);
    w.appendChild(topo);
    for (let r = 0; r < CORES.length; r += 12) { // duas fileiras de 12 cores
      const sw = el("div", "sws");
      CORES.slice(r, r + 12).forEach((c) => {
        const q = el("div", "sw"); q.style.backgroundColor = c;
        q.addEventListener("click", () => aplicarCor(c));
        sw.appendChild(q);
      });
      w.appendChild(sw);
    }
    return w;
  }

  function selecionar(opcoes, valor, aoMudar, largura) {
    const s = document.createElement("select");
    if (largura) s.style.width = largura;
    for (const [v, n] of opcoes) { const o = document.createElement("option"); o.value = v; o.textContent = n; s.appendChild(o); }
    s.value = valor;
    s.addEventListener("change", () => aoMudar(s.value));
    return s;
  }

  const urlFonte = (id) => SERVICO + "/fonte/img?id=" + encodeURIComponent(id);

  // escolha de fonte com a amostra de cada uma (a lista mostra o nome escrito na própria fonte)
  function seletorFonte(l) {
    const w = el("div");
    const atual = el("div", "ed-fonte");
    const pintarAtual = () => {
      atual.innerHTML = "";
      if (fontes.some((f) => f.id === l.f)) { const im = document.createElement("img"); im.src = urlFonte(l.f); atual.appendChild(im); }
      else atual.textContent = l.f;
      atual.appendChild(el("div", "seta", "▾"));
    };
    pintarAtual();
    const lista = el("div", "ed-flista"); lista.style.display = "none";
    let filtro = "", rodada = 0;
    const pintarLista = () => {
      lista.innerHTML = "";
      const busca = document.createElement("input"); busca.type = "text"; busca.placeholder = "Buscar fonte..."; busca.value = filtro;
      busca.addEventListener("change", () => { filtro = busca.value.trim().toLowerCase(); pintarLista(); });
      lista.appendChild(busca);
      const achadas = fontes.filter((f) => !filtro || f.nome.toLowerCase().indexOf(filtro) >= 0);
      const minha = ++rodada;
      let n = 0;
      const lote = () => {
        if (minha !== rodada || lista.style.display === "none") return;
        achadas.slice(n, n + 15).forEach((f) => {
          const it = el("div", "ed-fitem" + (f.id === l.f ? " sel" : ""));
          const im = document.createElement("img"); im.src = urlFonte(f.id); it.appendChild(im);
          it.addEventListener("click", () => { l.f = f.id; lista.style.display = "none"; rodada++; pintarAtual(); agendarPrevia(); });
          lista.appendChild(it);
        });
        n += 15;
        if (n < achadas.length) setTimeout(lote, 350); // vai carregando as outras sozinho
      };
      lote();
      if (!achadas.length) lista.appendChild(el("div", "dica", "Nenhuma fonte encontrada."));
    };
    atual.addEventListener("click", () => {
      const abrir = lista.style.display === "none";
      lista.style.display = abrir ? "block" : "none";
      if (abrir) pintarLista(); else rodada++;
    });
    w.appendChild(atual); w.appendChild(lista);
    return w;
  }

  // opções de uma linha (aparecem só para a linha escolhida)
  function opcoesLinha(l, i, semRemover, semPosicao) {
    const c = el("div", "ed-opc");
    c.appendChild(el("div", "rt", "Fonte")); c.lastChild.style.fontSize = "14px";
    c.appendChild(seletorFonte(l));
    c.appendChild(linha("Tamanho", stepper(l, "tam", 2, 30, 0.5, "%", 1)));
    if (!semPosicao) c.appendChild(linha("Altura na tela", stepper(l, "y", 5, 95, 1, "%")));
    if (!semPosicao) c.appendChild(linha("Posição lateral", stepper(l, "x", 10, 90, 1, "%")));
    if (!semPosicao) c.appendChild(linha("Inclinação", stepper(l, "rot", -30, 30, 1, "°")));
    c.appendChild(linha("Tudo em MAIÚSCULAS", simNao(l, "caixa")));
    c.appendChild(el("div", "rt", "Cor do texto")); c.lastChild.style.fontSize = "14px";
    c.appendChild(campoCor(l, "cor"));
    const efeito = (chave, rotulo, extra) => {
      const blk = el("div");
      blk.appendChild(linha(rotulo, simNao(l[chave], "on", () => { desenhar(); })));
      if (l[chave].on) extra(blk, l[chave]);
      c.appendChild(blk);
    };
    efeito("contorno", "Contorno nas letras", (b, o) => { b.appendChild(campoCor(o, "cor")); b.appendChild(linha("Espessura", stepper(o, "larg", 1, 20, 1, "%"))); });
    efeito("sombra", "Sombra", (b, o) => { b.appendChild(linha("Intensidade", stepper(o, "forca", 10, 100, 5, "%"))); });
    efeito("tarja", "Tarja atrás do texto", (b, o) => { b.appendChild(campoCor(o, "cor")); b.appendChild(linha("Opacidade", stepper(o, "opac", 10, 100, 5, "%"))); b.appendChild(linha("Cantos arredondados", stepper(o, "raio", 0, 60, 5, "%"))); });
    efeito("brilho", "Brilho (glow)", (b, o) => { b.appendChild(campoCor(o, "cor")); b.appendChild(linha("Intensidade", stepper(o, "forca", 10, 100, 5, "%"))); });
    if (!semRemover && E.linhas.length > 1) {
      const x = el("div", "ed-btn verm", "Remover esta linha");
      x.addEventListener("click", () => { E.linhas.splice(i, 1); E.marc = []; E.sel = Math.max(0, i - 1); desenhar(); agendarPrevia(); });
      c.appendChild(x);
    }
    return c;
  }

  let PALCO_W = 0;
  function ajustarPalco(idMold, idImg, idOv) { // palco 16:9 fixo; o vertical fica centralizado dentro dele
    const m = $(idMold), im = $(idImg); if (!m || !im) return;
    const W = m.offsetWidth; if (!W) return;
    PALCO_W = W;
    const H = Math.round(W * 9 / 16), vert = im.getAttribute("data-vert") === "1";
    m.style.height = H + "px";
    const iw = vert ? Math.round(H * 9 / 16) : W, esq = vert ? Math.round((W - iw) / 2) : 0;
    im.style.width = iw + "px"; im.style.height = H + "px"; im.style.marginLeft = esq + "px";
    im.style.maxWidth = iw + "px"; im.style.maxHeight = H + "px";
    try { im.setAttribute("width", String(iw)); im.setAttribute("height", String(H)); } catch (e) { /* segue */ }
    const ov = idOv ? $(idOv) : null;
    if (ov) { ov.style.left = esq + "px"; ov.style.top = "0px"; ov.style.width = iw + "px"; ov.style.height = H + "px"; }
  }
  // troca horizontal/vertical e liga/desliga guias SEM redesenhar a aba (assim a página não pula)
  function trocarFormatoLeve(st, v, botoes, idMold, idImg, idOv) {
    st.formato = v;
    botoes.forEach(([b, vv]) => { b.style.backgroundColor = vv === v ? "#4a3fa0" : ""; });
    const im = $(idImg); if (im) im.setAttribute("data-vert", v === "v" ? "1" : "0");
    ajustarPalco(idMold, idImg, idOv);
    const ov = idOv ? $(idOv) : null; if (ov) ov.innerHTML = "";
  }
  let MODO_CRIATIVO = false;
  function desenhar() { // redesenha sem o painel "pular": guarda a rolagem e reserva o espaço da prévia
    if (MODO_CRIATIVO) { desenharC(); return; }
    const y0 = Math.max(window.scrollY || 0, document.documentElement.scrollTop || 0, document.body.scrollTop || 0);
    desenharInterno();
    ajustarPalco("edMoldura", "edPrevia", "edOverlay");
    montarMolduras();
    const volta = () => { try { window.scrollTo(0, y0); } catch (e) { /* segue */ } try { document.documentElement.scrollTop = y0; document.body.scrollTop = y0; } catch (e) { /* segue */ } };
    volta(); setTimeout(volta, 60); setTimeout(volta, 350);
  }
  function desenharInterno() {
    if (E.sel === undefined || E.sel >= E.linhas.length) E.sel = 0;
    if (E.sel < -1) E.sel = -1;
    caixa.innerHTML = "";
    const topo = el("div", "ed-card");
    topo.appendChild(el("div", "ed-tit", "Criar um estilo"));
    const blocoSalvar = () => { // nome + botão salvar (nome sempre junto do Salvar)
      const w = el("div"); w.style.marginTop = "8px";
      const r = el("div", "rt", "Nome do estilo"); r.style.fontSize = "14px"; r.style.margin = "0"; w.appendChild(r);
      const campo = document.createElement("input"); campo.type = "text"; campo.className = "edNomeCampo"; campo.value = E.nome || ""; campo.placeholder = "Ex.: Meu estilo 1";
      campo.addEventListener("input", () => { E.nome = campo.value; for (const o of Array.from(document.querySelectorAll(".edNomeCampo"))) if (o !== campo) o.value = campo.value; });
      w.appendChild(campo);
      const bt = el("div", "ed-btn verde", "💾 Salvar estilo"); bt.style.marginTop = "8px";
      bt.addEventListener("click", () => salvarEstilo(bt));
      w.appendChild(bt);
      return w;
    };
    const fila = el("div"); fila.style.display = "flex";
    for (const [m, n] of [["novo", "Novo"], ["existente", "Usar um existente"]]) {
      const b = el("div", "ed-btn", n); b.style.width = "auto"; b.style.paddingLeft = "14px"; b.style.paddingRight = "14px"; b.style.marginRight = "6px";
      if (E.modo === m) b.style.backgroundColor = "#4a3fa0";
      b.addEventListener("click", () => {
        if (m === "novo") {
          if (E.modo === "novo") E.modo = null;
          else E = { nome: E.nome, base: "", editando: null, modo: "novo", sel: 0, marc: [], linhas: [linhaPadrao(0), linhaPadrao(1)], anim: { entrada: "pop", duracao: 0.28, atraso: 0.07, saida: "fade" } };
        } else E.modo = E.modo === "existente" ? null : "existente";
        desenhar(); agendarPrevia();
      });
      fila.appendChild(b);
    }
    topo.appendChild(fila);
    if (E.modo === "existente") {
      const bases = [["", "Escolha um estilo..."]].concat(estilos.map((e) => [e.nome, e.nome + (e.usuario ? " (meu)" : "")]));
      const sb = selecionar(bases, E.base || "", (v) => { if (v) carregarBase(v); });
      sb.style.marginTop = "8px"; topo.appendChild(sb);
      topo.appendChild(blocoSalvar());
    } else if (E.modo === "novo") topo.appendChild(blocoSalvar());
    caixa.appendChild(topo);
    const prev = el("div", "ed-card");
    prev.appendChild(el("div", "ed-tit", "Prévia (como a legenda fica parada)"));
    // formato do vídeo: horizontal ou vertical
    const fm = el("div"); fm.style.display = "flex"; fm.style.marginBottom = "6px";
    const botoesF = [];
    for (const [v, n] of [["h", "Vídeo horizontal"], ["v", "Vídeo vertical"]]) {
      const b = el("div", "ed-btn", n); b.style.marginRight = "6px"; b.style.width = "auto"; b.style.paddingLeft = "10px"; b.style.paddingRight = "10px";
      if ((E.formato || "h") === v) { b.style.backgroundColor = "#4a3fa0"; b.style.color = "#ffffff"; }
      botoesF.push([b, v]);
      b.addEventListener("click", () => { trocarFormatoLeve(E, v, botoesF, "edMoldura", "edPrevia", "edOverlay"); agendarPrevia(); });
      fm.appendChild(b);
    }
    const bg = el("div", "ed-btn", E.guias ? "Guias: ligadas" : "Guias: desligadas"); bg.style.width = "auto"; bg.style.paddingLeft = "10px"; bg.style.paddingRight = "10px";
    if (E.guias) { bg.style.backgroundColor = "#4a3fa0"; }
    bg.addEventListener("click", () => { E.guias = !E.guias; bg.textContent = E.guias ? "Guias: ligadas" : "Guias: desligadas"; bg.style.backgroundColor = E.guias ? "#4a3fa0" : ""; agendarPrevia(); });
    fm.appendChild(bg);
    prev.appendChild(fm);
    const moldura = el("div"); moldura.id = "edMoldura"; moldura.style.position = "relative";
    const vert = E.formato === "v";
    if (PALCO_W) moldura.style.height = Math.round(PALCO_W * 9 / 16) + "px"; // altura fixa: trocar horizontal/vertical não mexe na página
    const im = document.createElement("img"); im.id = "edPrevia"; im.className = "ed-prev"; im.setAttribute("data-vert", vert ? "1" : "0");
    im.style.display = "block";
    if (ULTIMA_PREVIA) im.src = ULTIMA_PREVIA; // mantém a imagem anterior até a nova ficar pronta (sem piscar)
    moldura.appendChild(im);
    const ovl = el("div"); ovl.id = "edOverlay"; ovl.style.position = "absolute"; ovl.style.left = "0px"; ovl.style.top = "0px";
    ovl.addEventListener("mousedown", aoApertarPrevia);
    moldura.appendChild(ovl);
    // setas dentro da prévia: movem a linha selecionada (ou todas, se nenhuma estiver aberta)
    let segurando = null;
    const pararSeta = () => { if (segurando) { clearTimeout(segurando); clearInterval(segurando); segurando = null; desenhar(); agendarPrevia(); } };
    document.addEventListener("mouseup", pararSeta);
    const mover = (dx, dy, continuo) => {
      const marcadas = E.linhas.filter((l, k) => (E.marc || []).indexOf(k) >= 0);
      const alvo = marcadas.length ? marcadas : ((E.sel >= 0 && E.linhas[E.sel]) ? [E.linhas[E.sel]] : E.linhas);
      if (!dx && !dy) {
        const mx = alvo.reduce((a, l) => a + l.x, 0) / alvo.length, my = alvo.reduce((a, l) => a + l.y, 0) / alvo.length;
        dx = 50 - mx; dy = 50 - my;
      }
      for (const l of alvo) { l.x = Math.max(5, Math.min(95, Math.round(l.x + dx))); l.y = Math.max(5, Math.min(95, Math.round(l.y + dy))); }
      E.msgMov = (alvo.length === 1 ? "1 linha" : alvo.length === E.linhas.length ? "Todas as linhas" : alvo.length + " linhas") + ": esquerda " + Math.round(alvo[0].x) + "%, altura " + Math.round(alvo[0].y) + "%";
      if (continuo) { agendarPrevia(true); return; }
      desenhar(); agendarPrevia();
    };
    const setas = [["↖", -3, -3], ["↑", 0, -3], ["↗", 3, -3], ["←", -3, 0], ["●", 0, 0], ["→", 3, 0], ["↙", -3, 3], ["↓", 0, 3], ["↘", 3, 3]];
    setas.forEach(([t, dx, dy], n) => {
      const r = Math.floor(n / 3), c = n % 3;
      const b = el("div", "", t);
      b.style.position = "absolute"; b.style.width = "26px"; b.style.height = "26px"; b.style.lineHeight = "26px"; b.style.textAlign = "center";
      b.style.right = (6 + (2 - c) * 28) + "px"; b.style.bottom = (6 + (2 - r) * 28) + "px";
      b.style.backgroundColor = "rgba(20,20,30,0.75)"; b.style.color = "#ffffff"; b.style.borderRadius = "6px"; b.style.cursor = "pointer"; b.style.fontSize = "14px";
      b.addEventListener("mousedown", (ev) => {
        ev.stopPropagation(); pararSeta();
        mover(dx, dy, true);
        if (!dx && !dy) { desenhar(); return; }
        segurando = setTimeout(() => { segurando = setInterval(() => mover(dx, dy, true), 90); }, 350);
      });
      moldura.appendChild(b);
    });
    prev.appendChild(moldura);
    const nm = (E.marc || []).length; const dica = el("div", "rt", (E.msgMov ? E.msgMov + ". " : "") + (nm ? "As setas movem as " + nm + " linha(s) marcada(s)." : E.sel >= 0 ? "As setas movem a Linha " + (E.sel + 1) + " (a que está aberta)." : "As setas movem todas as linhas juntas.")); dica.style.fontSize = "14px"; dica.style.marginTop = "6px";
    prev.appendChild(dica);

    caixa.appendChild(prev);

    // linhas: clique numa para abrir as opções dela
    const cl = el("div", "ed-card");
    const titL = el("div", "ed-tit", "Linhas do texto"); cl.appendChild(titL);
    const exp = el("div", "rt", "Clique na linha para marcá-la (as setas da prévia movem as marcadas). A seta ▾ abre as opções. Arraste o ≡ para mudar a profundidade: a de cima fica na frente das outras."); exp.style.fontSize = "14px"; cl.appendChild(exp);
    const limpar = (ev) => { if ((E.marc || []).length && (ev.target === cl || ev.target === titL || ev.target === exp || ev.target === caixa)) { E.marc = []; desenhar(); agendarPrevia(); } };
    cl.addEventListener("click", limpar); caixa.addEventListener("click", limpar);
    const itens = [];
    const iniciarArraste = (de) => { // arrastar pela alça ≡: solta onde quiser na lista (cima = na frente)
      let alvo = de;
      const onde = (ev) => { let k = itens.length - 1; for (let n = 0; n < itens.length; n++) { const r = itens[n].getBoundingClientRect(); if (ev.clientY < r.top + r.height / 2) { k = n; break; } } return k; };
      const marcar = (k) => itens.forEach((e, n) => { e.style.borderColor = n === k ? "#ffd60a" : ""; });
      marcar(de);
      const mover = (ev) => { alvo = onde(ev); marcar(alvo); };
      const soltar = () => {
        document.removeEventListener("mousemove", mover); document.removeEventListener("mouseup", soltar);
        if (alvo === de) { desenhar(); return; }
        const sel = E.sel >= 0 ? E.linhas[E.sel] : null; const marc = (E.marc || []).map((m) => E.linhas[m]);
        const t = E.linhas.splice(de, 1)[0]; E.linhas.splice(alvo, 0, t);
        if (sel) E.sel = E.linhas.indexOf(sel);
        E.marc = marc.map((l) => E.linhas.indexOf(l));
        desenhar(); agendarPrevia();
      };
      document.addEventListener("mousemove", mover); document.addEventListener("mouseup", soltar);
    };
    E.linhas.forEach((l, i) => {
      const nf = (fontes.find((f) => f.id === l.f) || { nome: l.f }).nome;
      const marcada = (E.marc || []).indexOf(i) >= 0;
      const it = el("div", "ed-item" + (marcada ? " sel" : ""));
      it.style.display = "flex"; it.style.alignItems = "center";
      const tx = el("div", "", (marcada ? "✓ " : "") + "Linha " + (i + 1) + "   ·   " + nf + "   ·   " + l.tam + "%"); tx.style.flex = "1";
      it.appendChild(tx);
      const alca = el("div", "", "≡"); alca.style.width = "24px"; alca.style.height = "24px"; alca.style.lineHeight = "24px"; alca.style.textAlign = "center"; alca.style.fontSize = "20px"; alca.style.color = "#8a8a9c"; alca.style.cursor = "grab"; alca.style.flexShrink = "0";
      alca.addEventListener("mousedown", (ev) => { ev.stopPropagation(); ev.preventDefault(); iniciarArraste(i); });
      const abre = el("div", "", i === E.sel ? "▸" : "▾"); abre.style.width = "30px"; abre.style.height = "28px"; abre.style.lineHeight = "28px"; abre.style.textAlign = "center"; abre.style.marginLeft = "4px"; abre.style.color = i === E.sel ? "#b9acff" : "#8a8a9c"; abre.style.fontSize = "22px";
      abre.addEventListener("click", (ev) => { ev.stopPropagation(); E.sel = (E.sel === i) ? -1 : i; desenhar(); agendarPrevia(); });
      it.appendChild(abre);
      itens.push(it);
      it.addEventListener("click", () => { // clicar na linha marca/desmarca (as setas movem as marcadas)
        const m = E.marc || []; const k = m.indexOf(i);
        E.marc = k >= 0 ? m.filter((v) => v !== i) : m.concat([i]);
        desenhar(); agendarPrevia();
      });
      const faixa = el("div"); faixa.style.display = "flex"; faixa.style.alignItems = "center";
      faixa.appendChild(alca); it.style.flex = "1"; faixa.appendChild(it);
      cl.appendChild(faixa);
      if (i === E.sel) cl.appendChild(opcoesLinha(l, i));
    });
    if (E.linhas.length < 5) {
      const mais = el("div", "ed-btn", "+ Adicionar linha");
      mais.addEventListener("click", () => { { const nl = linhaPadrao(E.linhas.length); nl.uid = Math.max(-1, ...E.linhas.map((x) => x.uid === undefined ? -1 : x.uid)) + 1; E.linhas.push(nl); } E.sel = E.linhas.length - 1; desenhar(); agendarPrevia(); });
      cl.appendChild(mais);
    }
    caixa.appendChild(cl);

    const an = el("div", "ed-card");
    const cab = el("div", "ed-tit"); cab.style.display = "flex"; cab.style.alignItems = "center"; cab.style.cursor = "pointer"; cab.style.margin = "0";
    const tt = el("div", "", "Animação"); tt.style.flex = "1";
    const sa = el("div", "", E.animAberta ? "▸" : "▾"); sa.style.fontSize = "22px"; sa.style.color = E.animAberta ? "#b9acff" : "#8a8a9c"; sa.style.paddingRight = "6px";
    cab.appendChild(tt); cab.appendChild(sa);
    cab.addEventListener("click", () => { E.animAberta = !E.animAberta; desenhar(); agendarPrevia(); });
    an.appendChild(cab);
    if (E.animAberta) {
      an.appendChild(selecionar(ANIMS, E.anim.entrada, (v) => { E.anim.entrada = v; agendarPrevia(); }));
      an.appendChild(linha("Velocidade da entrada (s)", stepper(E.anim, "duracao", 0.1, 1.2, 0.05, " s", 2)));
      an.appendChild(linha("Atraso entre linhas (s)", stepper(E.anim, "atraso", 0, 0.4, 0.02, " s", 2)));
      an.appendChild(linha("Saída suave (some devagar)", simNaoSaida({ v: E.anim.saida !== "nenhuma" })));
    }
    caixa.appendChild(an);
    const cNome = el("div", "ed-card");
    cNome.appendChild(el("div", "rt", "Nome do estilo")); cNome.lastChild.style.fontSize = "14px";
    const nome = document.createElement("input"); nome.type = "text"; nome.className = "edNomeCampo"; nome.value = E.nome; nome.placeholder = "Ex.: Meu estilo 1";
    nome.addEventListener("input", () => { E.nome = nome.value; for (const o of Array.from(document.querySelectorAll(".edNomeCampo"))) if (o !== nome) o.value = nome.value; });
    cNome.appendChild(nome);
    const salvar = el("div", "ed-btn verde", "💾 Salvar estilo"); salvar.style.marginTop = "8px";
    salvar.addEventListener("click", () => salvarEstilo(salvar));
    cNome.appendChild(salvar);
    caixa.appendChild(cNome);
    if (E.editando) {
      const ex = el("div", "ed-btn verm", "🗑 Excluir este estilo");
      ex.addEventListener("click", excluirEstilo);
      caixa.appendChild(ex);
    }
    const msg = el("div", "dica"); msg.id = "edMsg"; caixa.appendChild(msg);
  }
  function simNaoSaida(o) {
    return bolinha(o.v, (on) => { E.anim.saida = on ? "fade" : "nenhuma"; agendarPrevia(); });
  }
  const mensagem = (t, erro) => { const m = $("edMsg"); if (m) { m.textContent = t; m.style.color = erro ? "#ff8a80" : "#9a9a9a"; } };

  async function salvarEstilo(botao) {
    try {
      const nome = (E.nome || "").trim();
      if (!nome) {
        // avisa no próprio botão: fica vermelho com a mensagem e o campo do nome também
        if (botao && botao.style) {
          botao.textContent = "⚠ Dê um nome ao estilo primeiro";
          botao.style.backgroundColor = "#b3382c";
          const campos = Array.from(document.querySelectorAll(".edNomeCampo"));
          for (const c of campos) c.style.border = "1px solid #ff6b5e";
          if (campos[0] && campos[0].focus) { try { campos[0].focus(); } catch (e) { /* ok */ } }
          setTimeout(() => {
            botao.textContent = "💾 Salvar estilo"; botao.style.backgroundColor = "";
            for (const c of campos) c.style.border = "";
          }, 2500);
        }
        return mensagem("Dê um nome ao estilo.", true);
      }
      mensagem("Salvando...");
      const r = await chamar("/estilo/salvar", { nome, def: paraDef() });
      await recarregarEstilos();
      window.ppVerImg = Date.now();
      if (sel) sel.value = r.nome;
      try { const f = JSON.parse(localStorage.getItem("ppFavEstilos") || "null"); if (f && !f.includes(r.nome)) { f.push(r.nome); localStorage.setItem("ppFavEstilos", JSON.stringify(f)); } } catch (e) { /* sem armazenamento */ }
      E.editando = r.nome; E.nome = r.nome;
      desenhar(); agendarPrevia();
      mensagem("Estilo \"" + r.nome + "\" salvo e escolhido. Ele já aparece na galeria.");
    } catch (e) { mensagem("Não salvei: " + (e && e.message ? e.message : e), true); }
  }
  async function excluirEstilo() {
    try {
      const nome = E.editando;
      await chamar("/estilo/excluir", { nome });
      await recarregarEstilos();
      if (sel && sel.value === nome) sel.value = "aleatorio";
      E = { nome: "", base: "", editando: null, modo: "novo", linhas: [linhaPadrao(0), linhaPadrao(1)], anim: { entrada: "pop", duracao: 0.28, atraso: 0.07, saida: "fade" } };
      desenhar(); agendarPrevia();
      mensagem("Estilo \"" + nome + "\" excluído.");
    } catch (e) { mensagem("Não excluí: " + (e && e.message ? e.message : e), true); }
  }

  // mantém a lista de estilos do programa local e as opções da galeria sincronizadas
  async function recarregarEstilos() {
    const r = await (await fetch(SERVICO + "/estilos")).json();
    estilos = r.estilos || [];
    const meus = new Set(estilos.filter((e) => e.usuario).map((e) => e.nome));
    if (sel) {
      for (const o of Array.from(sel.options)) if (window.ppEstilosImg.has(o.value) && !meus.has(o.value)) sel.removeChild(o);
      for (const n of meus) {
        if (!Array.from(sel.options).some((o) => o.value === n)) { const o = document.createElement("option"); o.value = n; o.textContent = n; sel.appendChild(o); }
      }
    }
    window.ppEstilosImg = meus;
  }

  function carregarBase(nome) { // abre as opções de um estilo da galeria no criador
    const e = estilos.find((x) => x.nome === nome);
    if (!e) return false;
    const d = ordenarPorProfundidade(doDef(e.def), e.def);
    E = { nome: e.usuario ? e.nome : "", base: e.nome, editando: e.usuario ? e.nome : null, modo: "existente", sel: 0, marc: [], linhas: d.linhas, anim: d.anim };
    desenhar(); agendarPrevia();
    return true;
  }
  window.ppEscolheuEstilo = (nome) => { if (aberto && !MODO_CRIATIVO && E) carregarBase(nome); }; // trocou o estilo na galeria com o criador aberto

  botao.addEventListener("click", async () => {
    aberto = !aberto;
    caixa.style.display = aberto ? "block" : "none";
    botao.textContent = aberto ? "🎨 Fechar o criador de estilos" : "🎨 Criar / editar estilo";
    if (!aberto) return;
    try {
      if (!estilos.length) await recarregarEstilos();
      if (!fontes.length) { try { fontes = (await (await fetch(SERVICO + "/estilos/fontes")).json()).fontes || []; } catch (e) { fontes = []; } }
      if (!E) E = { nome: "", base: "", editando: null, modo: "novo", linhas: [linhaPadrao(0), linhaPadrao(1)], anim: { entrada: "pop", duracao: 0.28, atraso: 0.07, saida: "fade" } };
      // se um estilo está escolhido na galeria, já abre com as opções dele para editar
      let carregou = false;
      if (sel && sel.value && sel.value !== E.base && sel.value !== E.editando) carregou = carregarBase(sel.value);
      if (!carregou) { desenhar(); agendarPrevia(); } // "Aleatório" ou outro item que não é um estilo: abre o editor normal
    } catch (e) { caixa.textContent = "Não consegui abrir o criador: " + (e && e.message ? e.message : e); }
  });

  // =====================  ABA CRIATIVOS  =====================
  const caixaC = $("criativoCaixa");
  const ENTR_IMG = [["fade", "Surgir suave"], ["zoom", "Zoom (de perto para o normal)"], ["subir", "Entra de baixo"], ["descer", "Entra de cima"],
                    ["esquerda", "Entra da esquerda"], ["direita", "Entra da direita"], ["revelar", "Revelar (varredura)"], ["nenhuma", "Sem animação"]];
  const novoTexto = (titulo, tam, y, cor, larg) => ({ titulo, texto: "", larg, linha: Object.assign(linhaPadrao(0), { tam, y, cor }) });
  let C = null, timerC = null, ULTIMA_C = "", PALCO_C = 0;
  const padraoC = () => ({
    imagem: "", nomeImg: "",
    fundo: { escurecer: 40, desfoque: 0, zoomLento: true, entrada: "fade", duracao: 0.6, saida: true },
    textos: [novoTexto("Frase", 7, 45, "#FFFFFF", 78), novoTexto("Referências (opcional, uma por linha)", 4, 72, "#FFB000", 60)],
    anim: { entrada: "subir", duracao: 0.35, atraso: 0.12, saida: "fade", inicio: 0.5 },
    area: { x: 50, y: 50, larg: 80, alt: 50 }, pag: { ativo: false, linhas: 3 }, tempos: [],
    formato: "h", guias: false, abertoT: -1, animAberta: false, io: null,
    sec: { trecho: true, imagem: true, previa: true, textos: true, anim: false },
  });
  const salvarC = () => { try { localStorage.setItem("ppCriativo", JSON.stringify(Object.assign({}, C, { io: null }))); } catch (e) { /* sem armazenamento */ } };
  const carregarC = () => { try { const j = JSON.parse(localStorage.getItem("ppCriativo") || "null"); if (j && j.fundo && j.textos && j.textos.length) return Object.assign(padraoC(), j, { io: null, sec: Object.assign(padraoC().sec, j.sec || {}) }); } catch (e) { /* ignora */ } return padraoC(); };

  function linhaParaDefC(l) {
    const o = { f: l.f, tam: l.tam / 100, y: l.y / 100, x: l.x / 100, cor: hex2rgb(l.cor) || [255, 255, 255], caixa: l.caixa, rot: 0 };
    if (l.contorno.on) o.contorno = { cor: hex2rgb(l.contorno.cor) || [0, 0, 0], larg: l.contorno.larg / 100 };
    o.sombra = l.sombra.on ? { opac: l.sombra.forca / 100 } : { ligada: false };
    if (l.tarja.on) o.tarja = { cor: hex2rgb(l.tarja.cor) || [0, 0, 0], opac: l.tarja.opac / 100, raio: l.tarja.raio / 100, pad: 0.25 };
    if (l.brilho.on) o.brilho = { cor: hex2rgb(l.brilho.cor) || [255, 215, 0], forca: l.brilho.forca / 100, raio: 0.25 };
    return o;
  }
  function defC() {
    return {
      imagem: C.imagem, guias: !!C.guias,
      fundo: { escurecer: C.fundo.escurecer / 100, desfoque: C.fundo.desfoque, zoomLento: C.fundo.zoomLento, entrada: C.fundo.entrada, duracao: C.fundo.duracao, saida: C.fundo.saida },
      textos: C.textos.map((t) => ({ texto: t.texto, larg: t.larg / 100, linha: linhaParaDefC(t.linha) })),
      anim: { entrada: C.anim.entrada, duracao: C.anim.duracao, atraso: C.anim.atraso, saida: C.anim.saida, inicio: C.anim.inicio },
      area: { x: C.area.x / 100, y: C.area.y / 100, larg: C.area.larg / 100, alt: C.area.alt / 100 },
      paginas: { ativo: !!C.pag.ativo, linhas: C.pag.linhas },
      tempos: C.tempos || [],
    };
  }
  const msgC = (t, erro) => { const m = $("crMsg"); if (m) { m.textContent = t; m.style.color = erro ? "#ff8a80" : "#9a9a9a"; } };
  const fmtT = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0") + "." + String(Math.round((s % 1) * 10) % 10);

  function agendarPreviaC() {
    salvarC();
    if (timerC) clearTimeout(timerC);
    timerC = setTimeout(async () => {
      timerC = null;
      try {
        await chamar("/criativo/previa", { def: defC(), formato: C.formato });
        ULTIMA_C = SERVICO + "/painel/img/prev_criativo.png?t=" + Date.now();
        const im = $("crPrevia"); if (im) { im.src = ULTIMA_C; ajustarPalco("crMoldura", "crPrevia", null); setTimeout(() => ajustarPalco("crMoldura", "crPrevia", null), 120); }
      } catch (e) { msgC("Prévia: " + (e && e.message ? e.message : e), true); }
    }, 300);
  }

  function desenharC() {
    const y0 = Math.max(window.scrollY || 0, document.documentElement.scrollTop || 0, document.body.scrollTop || 0);
    desenharCInterno();
    ajustarPalco("crMoldura", "crPrevia", null);
    if ($("crMoldura")) PALCO_C = PALCO_W;
    const volta = () => { try { window.scrollTo(0, y0); } catch (e) { /* segue */ } try { document.documentElement.scrollTop = y0; document.body.scrollTop = y0; } catch (e) { /* segue */ } };
    volta(); setTimeout(volta, 60); setTimeout(volta, 350);
  }

  // caixa que abre/fecha ao clicar no título (fechada: o conteúdo vai para uma caixa solta, que não aparece)
  const secao = (chave, titulo) => {
    const aberta = C.sec[chave] !== false;
    const card = el("div", "ed-card");
    const cab = el("div"); cab.style.display = "flex"; cab.style.alignItems = "center"; cab.style.cursor = "pointer";
    cab.style.padding = "9px 10px"; cab.style.borderRadius = "8px"; cab.style.backgroundColor = "#2d2d46"; cab.style.marginBottom = aberta ? "6px" : "0";
    const tt = el("div", "", titulo); tt.style.flex = "1"; tt.style.fontSize = "16px"; tt.style.fontWeight = "700"; tt.style.color = "#ffffff";
    const sa = el("div", "", aberta ? "▸" : "▾"); sa.style.fontSize = "22px"; sa.style.color = aberta ? "#b9acff" : "#8a8a9c";
    cab.appendChild(tt); cab.appendChild(sa);
    cab.addEventListener("click", () => { C.sec[chave] = !aberta; salvarC(); desenharC(); });
    card.appendChild(cab);
    caixaC.appendChild(card);
    return aberta ? card : el("div");
  };
  const cartao = (titulo) => { const c = el("div", "ed-card"); c.appendChild(el("div", "ed-tit", titulo)); return c; };
  const miniBtn = (txt, fn, cls) => { const b = el("div", "ed-btn" + (cls ? " " + cls : ""), txt); b.style.width = "auto"; b.style.paddingLeft = "10px"; b.style.paddingRight = "10px"; b.addEventListener("click", fn); return b; };

  function desenharCInterno() {
    caixaC.innerHTML = "";
    // ---- 1. trecho IN/OUT + fala
    const t1 = secao("trecho", "1. Trecho na sequência (IN/OUT)");
    const info = el("div", "rt", C.io ? "Trecho marcado: " + fmtT(C.io.ini) + " até " + fmtT(C.io.fim) + "  (" + (C.io.fim - C.io.ini).toFixed(1).replace(".", ",") + " s)" : "Na timeline: cursor no começo e tecla I; cursor no fim e tecla O. Depois clique em Ler IN/OUT.");
    info.style.fontSize = "12px"; info.style.marginBottom = "4px"; t1.appendChild(info);
    const lin1 = el("div"); lin1.style.display = "flex";
    const bLer = miniBtn("Ler IN/OUT", () => semPressa(async () => { await lerInOutC(true); desenharC(); }));
    bLer.style.marginRight = "6px"; lin1.appendChild(bLer);
    lin1.appendChild(miniBtn("✍ Escrever o que foi dito", () => semPressa(escreverFalaC), "verde"));
    t1.appendChild(lin1);

    // ---- 2. imagem de fundo
    const t2 = secao("imagem", "2. Imagem de fundo");
    const lin2 = el("div"); lin2.style.display = "flex"; lin2.style.alignItems = "center";
    const bImg = miniBtn(C.imagem ? "Trocar imagem" : "Escolher imagem", escolherImagemC);
    bImg.style.marginRight = "8px"; lin2.appendChild(bImg);
    const nomeI = el("div", "rt", C.imagem ? C.nomeImg : "Sem imagem (usa cor lisa)"); nomeI.style.fontSize = "14px"; nomeI.style.flex = "1"; lin2.appendChild(nomeI);
    if (C.imagem) lin2.appendChild(miniBtn("✕", () => { C.imagem = ""; C.nomeImg = ""; desenharC(); agendarPreviaC(); }));
    t2.appendChild(lin2);
    t2.appendChild(linha("Escurecer a imagem", stepper(C.fundo, "escurecer", 0, 90, 5, "%")));
    t2.appendChild(linha("Desfoque", stepper(C.fundo, "desfoque", 0, 30, 1, "")));
    t2.appendChild(linha("Zoom lento durante o criativo", bolinha(C.fundo.zoomLento, (on) => { C.fundo.zoomLento = on; agendarPreviaC(); })));
    t2.appendChild(linha("Animação de entrada da imagem", selecionar(ENTR_IMG, C.fundo.entrada, (v) => { C.fundo.entrada = v; agendarPreviaC(); }, "190px")));
    t2.appendChild(linha("Duração da entrada (s)", stepper(C.fundo, "duracao", 0.1, 2, 0.1, " s", 1)));
    t2.appendChild(linha("Sumir suave no final", bolinha(C.fundo.saida, (on) => { C.fundo.saida = on; agendarPreviaC(); })));

    // ---- prévia
    const tp = secao("previa", "Prévia (como o criativo fica parado)");
    const fm = el("div"); fm.style.display = "flex"; fm.style.marginBottom = "6px";
    const botoesC = [];
    for (const [v, n] of [["h", "Vídeo horizontal"], ["v", "Vídeo vertical"]]) {
      const b = el("div", "ed-btn", n); b.style.marginRight = "6px"; b.style.width = "auto"; b.style.paddingLeft = "10px"; b.style.paddingRight = "10px";
      if (C.formato === v) { b.style.backgroundColor = "#4a3fa0"; }
      botoesC.push([b, v]);
      b.addEventListener("click", () => { trocarFormatoLeve(C, v, botoesC, "crMoldura", "crPrevia", null); agendarPreviaC(); });
      fm.appendChild(b);
    }
    const bg = el("div", "ed-btn", C.guias ? "Guias: ligadas" : "Guias: desligadas"); bg.style.width = "auto"; bg.style.paddingLeft = "10px"; bg.style.paddingRight = "10px";
    if (C.guias) bg.style.backgroundColor = "#4a3fa0";
    bg.addEventListener("click", () => { C.guias = !C.guias; bg.textContent = C.guias ? "Guias: ligadas" : "Guias: desligadas"; bg.style.backgroundColor = C.guias ? "#4a3fa0" : ""; agendarPreviaC(); });
    fm.appendChild(bg); tp.appendChild(fm);
    const vert = C.formato === "v";
    const mold = el("div"); mold.id = "crMoldura"; mold.style.position = "relative";
    if (PALCO_C) mold.style.height = Math.round(PALCO_C * 9 / 16) + "px";
    const im = document.createElement("img"); im.id = "crPrevia"; im.className = "ed-prev"; im.setAttribute("data-vert", vert ? "1" : "0"); im.style.display = "block";
    if (ULTIMA_C) im.src = ULTIMA_C;
    mold.appendChild(im); tp.appendChild(mold);

    // ---- 3. textos
    const t3 = secao("textos", "3. Textos");
    C.textos.forEach((t, i) => {
      const cab = el("div"); cab.style.display = "flex"; cab.style.alignItems = "center"; cab.style.marginTop = "6px";
      const nome = el("div", "rt", t.titulo); nome.style.flex = "1"; nome.style.fontSize = "14px"; cab.appendChild(nome);
      const ab = el("div", "", "Estilo ▾"); ab.style.fontSize = "12px"; ab.style.cursor = "pointer"; ab.style.padding = "2px 6px"; ab.style.color = C.abertoT === i ? "#b9acff" : "#8a8a9c";
      ab.addEventListener("click", () => { C.abertoT = C.abertoT === i ? -1 : i; desenharC(); agendarPreviaC(); });
      cab.appendChild(ab); t3.appendChild(cab);
      const ta = document.createElement("textarea");
      ta.value = t.texto; ta.rows = i === 0 ? 9 : 5; ta.style.fontSize = "16px"; ta.style.lineHeight = "22px"; ta.style.minHeight = (i === 0 ? 200 : 120) + "px"; ta.placeholder = i === 0 ? "Escreva a frase (ou use \"Escrever o que foi dito\")" : "Uma por linha, na ordem dos trechos. Ex.:\nMateus 5:5\nMateus 5:9";
      ta.style.width = "100%"; ta.style.boxSizing = "border-box"; ta.style.backgroundColor = "#0f0f16"; ta.style.color = "#e6e6ee"; ta.style.border = "1px solid #3a3a4c"; ta.style.borderRadius = "8px"; ta.style.padding = "8px";
      ta.addEventListener("input", () => { t.texto = ta.value; agendarPreviaC(); });
      t3.appendChild(ta);
      if (i === 0) { const d0 = el("div", "rt", "Para a referência trocar, separe os trechos do texto com uma linha em branco: o 1º trecho usa a 1ª referência, o 2º usa a 2ª, e assim por diante."); d0.style.fontSize = "13px"; d0.style.color = "#8a8a9c"; t3.appendChild(d0); }
      if (i === 0) {
        t3.appendChild(linha("Entrar por partes, acompanhando a fala", bolinha(C.pag.ativo, (on) => { C.pag.ativo = on; desenharC(); agendarPreviaC(); })));
        if (C.pag.ativo) t3.appendChild(linha("Quantas linhas por vez", stepper(C.pag, "linhas", 1, 8, 1, "")));
        const ta2 = el("div", "rt", "Espaço do texto (retângulo verde na prévia, com as guias ligadas)"); ta2.style.fontSize = "14px"; ta2.style.marginTop = "6px"; t3.appendChild(ta2);
        t3.appendChild(linha("Largura do espaço", stepper(C.area, "larg", 30, 90, 5, "%")));
        t3.appendChild(linha("Altura do espaço", stepper(C.area, "alt", 10, 90, 5, "%")));
        t3.appendChild(linha("Posição horizontal", stepper(C.area, "x", 10, 90, 1, "%")));
        t3.appendChild(linha("Posição vertical", stepper(C.area, "y", 10, 90, 1, "%")));
      } else t3.appendChild(linha("Largura do texto na tela", stepper(t, "larg", 30, 90, 5, "%")));
      if (C.abertoT === i) t3.appendChild(opcoesLinha(t.linha, i, true, i === 0));
    });

    // ---- animação do texto
    const t4 = secao("anim", "Animação do texto");
    {
      t4.appendChild(selecionar(ANIMS, C.anim.entrada, (v) => { C.anim.entrada = v; agendarPreviaC(); }));
      t4.appendChild(linha("Velocidade da entrada (s)", stepper(C.anim, "duracao", 0.1, 1.2, 0.05, " s", 2)));
      t4.appendChild(linha("Atraso entre linhas (s)", stepper(C.anim, "atraso", 0, 0.4, 0.02, " s", 2)));
      t4.appendChild(linha("Texto começa depois de (s)", stepper(C.anim, "inicio", 0, 3, 0.1, " s", 1)));
      t4.appendChild(linha("Saída suave (some devagar)", bolinha(C.anim.saida !== "nenhuma", (on) => { C.anim.saida = on ? "fade" : "nenhuma"; agendarPreviaC(); })));
    }

    const criar = el("div", "ed-btn verde", "🎬 Criar criativo no trecho IN/OUT");
    criar.style.padding = "14px"; criar.style.fontSize = "15px";
    criar.addEventListener("click", () => semPressa(criarCriativoC));
    caixaC.appendChild(criar);
    const m = el("div", "dica"); m.id = "crMsg"; caixaC.appendChild(m);
  }

  function subirAoTopo() { // para a pessoa ver a barra de carregamento e as mensagens
    try { window.scrollTo(0, 0); } catch (e) { /* segue */ }
    try { document.documentElement.scrollTop = 0; document.body.scrollTop = 0; } catch (e) { /* segue */ }
    setTimeout(() => { try { window.scrollTo(0, 0); } catch (e) { /* segue */ } }, 80);
  }
  async function escolherImagemC() {
    try {
      const fs = require("uxp").storage.localFileSystem;
      const arq = await fs.getFileForOpening({ types: ["png", "jpg", "jpeg", "webp", "bmp"] });
      if (!arq) return;
      C.imagem = arq.nativePath; C.nomeImg = String(arq.nativePath).split(/[\\/]/).pop();
      desenharC(); agendarPreviaC();
    } catch (e) { msgC("Não consegui abrir o seletor de imagens: " + (e && e.message ? e.message : e), true); }
  }

  async function seqEInOut() {
    const ppro = require("premierepro");
    const projeto = await ppro.Project.getActiveProject();
    const seq = await projeto.getActiveSequence();
    if (!seq) throw new Error("Nenhuma sequência ativa. Clique na sequência na timeline.");
    const s = async (f) => { const t = await f(); return t && t.seconds !== undefined ? t.seconds : Number(t); };
    const fimSeq = await s(() => seq.getEndTime());
    let pin = 0, pout = 0;
    try { pin = await s(() => seq.getInPoint()); pout = await s(() => seq.getOutPoint()); } catch (e) { pin = 0; pout = 0; }
    const ini = Math.max(0, pin), fim = Math.min(pout, fimSeq);
    return { ppro, projeto, seq, s, ini, fim, fimSeq };
  }
  async function lerInOutC(avisar) {
    const r = await seqEInOut();
    if (!(r.fim > r.ini + 0.3)) {
      C.io = null;
      if (avisar) msgC("Marque o trecho na timeline: cursor no começo e tecla I, cursor no fim e tecla O. Depois clique em Ler IN/OUT.", true);
      return null;
    }
    C.io = { ini: r.ini, fim: r.fim };
    return r;
  }

  async function escreverFalaC() {
    subirAoTopo();
    try {
      const r = await lerInOutC(true);
      if (!r) { desenharC(); return; }
      const { ppro, seq, s, ini, fim } = r;
      const nA = await seq.getAudioTrackCount();
      const escolha = ($("estAudio") && $("estAudio").value) || "auto";
      const clipesDe = async (i) => {
        const tr = await seq.getAudioTrack(i);
        const lista = [];
        for (const it of await tr.getTrackItems(1, false)) {
          let des = false; try { des = !!(await it.isDisabled()); } catch (e) { des = false; }
          const a = await s(() => it.getStartTime()), b = await s(() => it.getEndTime());
          if (!des && b > ini + 0.05 && a < fim - 0.05) lista.push({ it, a, b });
        }
        return lista;
      };
      let clipes = [], ia = -1;
      if (escolha !== "auto") { ia = parseInt(escolha, 10); clipes = ia < nA ? await clipesDe(ia) : []; }
      else for (let i = 0; i < nA && !clipes.length; i++) { clipes = await clipesDe(i); ia = i; }
      if (!clipes.length) { msgC("Não achei áudio de fala nesse trecho. Confira a trilha de áudio da fala (aba Legendas > Avançado).", true); return; }
      clipes.sort((x, y) => x.a - y.a);
      const partes = [], tempos = [];
      let k = 0;
      for (const c of clipes) {
        k++;
        mostrar("Lendo a fala (clipe " + k + " de " + clipes.length + ", trilha A" + (ia + 1) + ")...\nNa primeira vez pode levar alguns minutos. Não feche o Premiere.");
        const pi = await c.it.getProjectItem();
        const cl = await ppro.ClipProjectItem.cast(pi);
        const arquivo = await cl.getMediaFilePath();
        if (!arquivo) continue;
        const noClipe = await s(() => c.it.getInPoint());
        const a = Math.max(c.a, ini), b = Math.min(c.b, fim);
        const rr = await chamar("/texto_trecho", { path: arquivo, inicio: noClipe + (a - c.a), fim: noClipe + (b - c.a),
          model: $("modelo").value, device: $("dispositivo").value, language: "pt" });
        if (rr.texto) partes.push(rr.texto);
        for (const w of (rr.palavras || [])) tempos.push(Math.max(0, c.a + (w.s - noClipe) - ini));
      }
      const texto = partes.join(" ").replace(/\s+/g, " ").trim();
      if (!texto) { msgC("Não encontrei fala nesse trecho.", true); return; }
      C.textos[0].texto = texto;
      C.tempos = tempos.sort((x, y) => x - y);
      C.pag.ativo = true;
      desenharC(); agendarPreviaC();
      msgC("Escrevi o que foi dito (trilha A" + (ia + 1) + ") e deixei o texto entrando por partes, no ritmo da fala. Confira e corrija o texto abaixo, se precisar.");
    } catch (e) { msgC("Não consegui ler a fala: " + (e && e.message ? e.message : e), true); }
  }

  async function criarCriativoC() {
    let etapa = "ler o trecho";
    subirAoTopo();
    try {
      const r = await lerInOutC(true);
      if (!r) { desenharC(); return; }
      const { ppro, projeto, seq, s, ini, fim } = r;
      const dur = fim - ini;
      if (!C.textos.some((t) => t.texto.trim()) && !C.imagem) { msgC("Escolha uma imagem ou escreva um texto.", true); return; }
      etapa = "achar uma trilha de vídeo livre";
      const nV = await seq.getVideoTrackCount();
      const ehCriativo = (n) => /^criativo_\d+\.mov$/i.test(String(n));
      const antigos = []; // criativos feitos antes por este plugin, no mesmo lugar: serão trocados pelo novo
      const bloqueada = new Array(nV).fill(false);
      for (let i = 1; i < nV; i++) {
        const tr = await seq.getVideoTrack(i);
        for (const it of await tr.getTrackItems(1, false)) {
          const a = await s(() => it.getStartTime()), b = await s(() => it.getEndTime());
          if (!(b > ini + 0.05 && a < fim - 0.05)) continue;
          let nome = "";
          try { nome = (await it.getProjectItem()).name; } catch (e) { nome = ""; }
          const sobre = Math.min(b, fim) - Math.max(a, ini);
          if (ehCriativo(nome) && sobre >= 0.5 * Math.min(b - a, fim - ini)) antigos.push({ it, trilha: i });
          else bloqueada[i] = true;
        }
      }
      let iv = -1;
      const preferida = antigos.length ? antigos[0].trilha : -1;
      if (preferida >= 1 && !bloqueada[preferida]) iv = preferida;
      for (let i = nV - 1; i >= 1 && iv < 0; i--) if (!bloqueada[i]) iv = i;
      let criouTrilha = false;
      if (iv < 0) { iv = nV; criouTrilha = true; } // nenhuma livre: ao colocar numa trilha acima da última, o Premiere cria a trilha
      let LARG = 1920, ALT = 1080;
      try { const fs = await seq.getFrameSize(); if (fs && fs.width > 0) { LARG = fs.width; ALT = fs.height; } } catch (e) { /* usa 1920x1080 */ }
      etapa = "desenhar o criativo";
      mostrar("Desenhando o criativo (" + dur.toFixed(1).replace(".", ",") + " s)...");
      const ov = await chamar("/criativo/gerar", { def: defC(), w: LARG, h: ALT, fps: 30, dur });
      etapa = "importar o criativo";
      mostrar("Colocando o criativo na trilha V" + (iv + 1) + "...");
      const { porNome } = await importarLegendas(ppro, projeto, [ov.arquivo], "Criativos PODCAST PRO");
      const item = porNome.get(String(ov.arquivo).split(/[\\/]/).pop());
      if (!item) throw new Error("o criativo não apareceu no projeto");
      etapa = "colocar na sequência";
      const ed = await ppro.SequenceEditor.getEditor(seq);
      let trocados = 0;
      if (antigos.length) {
        etapa = "tirar o criativo antigo da sequência";
        try {
          const sel = await seq.createEmptySelection();
          for (const x of antigos) { await sel.addItem(x.it, true); trocados++; }
          await executar(projeto, "Criativo: tirar o antigo", () => ed.createRemoveItemsAction(sel, false, ppro.Constants.MediaType.VIDEO));
          await dormir(600);
        } catch (e) { trocados = 0; msgC("Não consegui tirar o criativo antigo (" + (e && e.message ? e.message : e) + "). O novo foi colocado por cima.", true); }
        etapa = "colocar na sequência";
      }
      const tIni = await ppro.TickTime.createWithSeconds(ini);
      await executar(projeto, "Criativo: colocar", () => ed.createOverwriteItemAction(item, tIni, iv, 0));
      let nV2 = nV;
      try { nV2 = await seq.getVideoTrackCount(); } catch (e) { nV2 = nV; }
      if (criouTrilha && nV2 <= nV) throw new Error("o Premiere não criou a nova trilha de vídeo. Adicione uma trilha de vídeo vazia (botão direito no nome das trilhas > Adicionar trilha) e tente de novo");
      let orgC = "";
      try { orgC = await organizarCriativos(ppro, projeto); } catch (e) { /* opcional */ }
      mostrar((criouTrilha ? "Não havia trilha livre, então criei a V" + (iv + 1) + ". " : "") + (trocados ? "Troquei o criativo antigo pelo novo. " : "") + "Pronto! Criativo de " + dur.toFixed(1).replace(".", ",") + " s na trilha V" + (iv + 1) + " a partir de " + fmtT(ini) + ". É um clipe normal: arraste para mover ou puxe a ponta para mudar a duração. (Ctrl+Z desfaz.)" + orgC);
      msgC("Criativo colocado na trilha V" + (iv + 1) + ".");
    } catch (e) { const m = "Não consegui criar o criativo (etapa: " + etapa + "): " + (e && e.message ? e.message : e); mostrar(m, true); msgC(m, true); }
  }

  async function abrirCriativos() {
    MODO_CRIATIVO = true;
    if (!C) C = carregarC();
    if (!fontes.length) { try { fontes = (await (await fetch(SERVICO + "/estilos/fontes")).json()).fontes || []; } catch (e) { fontes = []; } }
    desenharCInterno(); agendarPreviaC();
    subirAoTopo(); // aba nova sempre começa no topo
  }
  Array.from(document.querySelectorAll("#abas .pill")).forEach((b) => b.addEventListener("click", () => {
    if (b.id === "abaCriativos") abrirCriativos(); else MODO_CRIATIVO = false;
  }));

  // estilos já criados aparecem na galeria ao abrir o painel
  (async function () { try { await recarregarEstilos(); } catch (e) { /* programa local ainda iniciando */ } })();
})();
