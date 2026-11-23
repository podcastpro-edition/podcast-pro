// PODCAST PRO - instalador v13 (C#, compilado com o csc que já vem no Windows)
// Mesma tela e mesmas etapas do instalador v12 (Go), agora com a versão 2.x embutida
// e com a escolha do disco onde instalar (C: por padrão).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using Microsoft.Win32;

class Instalador
{
    const string VERSAO = "2.0.3";
    const string URL_PYTHON = "https://www.python.org/ftp/python/3.12.8/python-3.12.8-embed-amd64.zip";
    const string URL_PIP = "https://bootstrap.pypa.io/get-pip.py";
    static readonly string[] URLS_FFMPEG = {
        "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
        "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" };
    const string UPIA = @"C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe";
    const string NOME_ATALHO = "PODCAST PRO - Reiniciar servidor";

    static readonly string[] NOMES = {
        "Copiar o programa",
        "Instalar o Python (só para o PODCAST PRO)",
        "Baixar o FFmpeg (áudio e vídeo)",
        "Instalar os pacotes (a parte mais demorada)",
        "Baixar o modelo da busca por sentido",
        "Ligar sozinho com o Windows",
        "Instalar o painel no Premiere" };
    static readonly int[] PESOS = { 3, 10, 20, 45, 12, 5, 5 };

    // estado mostrado na tela
    static readonly object trava = new object();
    static int[] passos = new int[7];   // 0 pendente, 1 fazendo, 2 ok, 3 erro
    static double dentro = 0;           // progresso dentro do passo atual (0..1)
    static string msg = "", erro = "", painel = "auto";
    static bool rodando = false, pronto = false, cancelado = false;
    static string RAIZ = @"C:\PODCAST_PRO";
    static StreamWriter log;
    static DateTime ultimoContato = DateTime.Now;
    static string TESTE = null; // --teste <pasta>: instala só nessa pasta, sem mexer no Windows nem no Premiere

    [STAThread]
    static int Main(string[] args)
    {
        ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | (SecurityProtocolType)12288; // TLS 1.2 e 1.3
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--desinstalar") return Desinstalar();
            if (args[i] == "--teste" && i + 1 < args.Length) { TESTE = args[i + 1]; RAIZ = TESTE; }
        }
        TcpListener srv = new TcpListener(IPAddress.Loopback, 0);
        srv.Start();
        int porta = ((IPEndPoint)srv.LocalEndpoint).Port;
        AbrirJanela("http://127.0.0.1:" + porta + "/");
        // se a janela for fechada pelo X, a tela para de perguntar o estado: aí o instalador sai sozinho
        Thread vigia = new Thread(delegate () {
            while (true)
            {
                Thread.Sleep(2000);
                if (!rodando && (DateTime.Now - ultimoContato).TotalSeconds > 25) Environment.Exit(0);
            }
        });
        vigia.IsBackground = true; vigia.Start();
        while (true)
        {
            TcpClient c = srv.AcceptTcpClient();
            ThreadPool.QueueUserWorkItem(delegate (object o) { Atender((TcpClient)o); }, c);
        }
    }

    // ------------------------------------------------------------------ janela (Edge em modo aplicativo)
    static void AbrirJanela(string url)
    {
        string[] edges = {
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86) + @"\Microsoft\Edge\Application\msedge.exe",
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles) + @"\Microsoft\Edge\Application\msedge.exe" };
        string perfil = Path.Combine(Path.GetTempPath(), "podcastpro_instalador");
        foreach (string e in edges)
        {
            if (!File.Exists(e)) continue;
            try
            {
                Process.Start(e, "--app=" + url + " --user-data-dir=\"" + perfil + "\" --no-first-run --window-size=520,440");
                return;
            }
            catch { }
        }
        Process.Start(url); // sem Edge: abre no navegador padrão
    }

    // ------------------------------------------------------------------ servidor da tela
    static void Atender(TcpClient c)
    {
        try
        {
            using (c)
            {
                NetworkStream ns = c.GetStream();
                StreamReader rd = new StreamReader(ns, Encoding.ASCII);
                string linha = rd.ReadLine();
                if (linha == null) return;
                string h;
                while (!string.IsNullOrEmpty(h = rd.ReadLine())) { }
                string[] p = linha.Split(' ');
                string caminho = p.Length > 1 ? p[1] : "/";
                string rota = caminho.Split('?')[0];
                string q = caminho.Contains("?") ? caminho.Substring(caminho.IndexOf('?') + 1) : "";
                ultimoContato = DateTime.Now;
                string tipo = "application/json; charset=utf-8";
                byte[] corpo;
                if (rota == "/") { corpo = Recurso("instalador.html"); tipo = "text/html; charset=utf-8"; }
                else if (rota == "/estado") corpo = Encoding.UTF8.GetBytes(Estado());
                else if (rota == "/discos") corpo = Encoding.UTF8.GetBytes(Discos());
                else if (rota == "/iniciar" || rota == "/de_novo")
                {
                    string d = Param(q, "disco");
                    if (TESTE == null && !string.IsNullOrEmpty(d) && d.Length == 1 && char.IsLetter(d[0])) RAIZ = d.ToUpper() + @":\PODCAST_PRO";
                    Iniciar();
                    corpo = Encoding.UTF8.GetBytes("{\"ok\":true}");
                }
                else if (rota == "/cancelar") { cancelado = true; corpo = Encoding.UTF8.GetBytes("{}"); Sair(400); }
                else if (rota == "/fechar") { corpo = Encoding.UTF8.GetBytes("{}"); Sair(400); }
                else corpo = Encoding.UTF8.GetBytes("{\"erro\":\"rota\"}");
                string cab = "HTTP/1.1 200 OK\r\nContent-Type: " + tipo + "\r\nCache-Control: no-store\r\nContent-Length: " + corpo.Length + "\r\nConnection: close\r\n\r\n";
                byte[] cb = Encoding.ASCII.GetBytes(cab);
                ns.Write(cb, 0, cb.Length);
                ns.Write(corpo, 0, corpo.Length);
                ns.Flush();
            }
        }
        catch { }
    }

    static string Param(string q, string nome)
    {
        foreach (string par in q.Split('&'))
        {
            int i = par.IndexOf('=');
            if (i > 0 && par.Substring(0, i) == nome) return Uri.UnescapeDataString(par.Substring(i + 1));
        }
        return "";
    }

    static void Sair(int ms)
    {
        new Thread(delegate () { Thread.Sleep(ms); Environment.Exit(0); }).Start();
    }

    static string J(string s)
    {
        StringBuilder b = new StringBuilder("\"");
        foreach (char ch in s ?? "")
        {
            if (ch == '"' || ch == '\\') b.Append('\\').Append(ch);
            else if (ch == '\n') b.Append("\\n");
            else if (ch == '\r') { }
            else if (ch < 32) b.Append(' ');
            else b.Append(ch);
        }
        return b.Append('"').ToString();
    }

    static string Estado()
    {
        lock (trava)
        {
            double tot = 0, soma = 0;
            for (int i = 0; i < 7; i++)
            {
                soma += PESOS[i];
                if (passos[i] == 2) tot += PESOS[i];
                else if (passos[i] == 1) tot += PESOS[i] * Math.Max(0, Math.Min(1, dentro));
            }
            StringBuilder nomes = new StringBuilder(), ps = new StringBuilder();
            for (int i = 0; i < 7; i++)
            {
                if (i > 0) { nomes.Append(','); ps.Append(','); }
                nomes.Append(J(NOMES[i])); ps.Append(passos[i]);
            }
            return "{\"rodando\":" + (rodando ? "true" : "false") + ",\"pronto\":" + (pronto ? "true" : "false") +
                   ",\"total\":" + (int)Math.Floor(100 * tot / soma) + ",\"msg\":" + J(msg) + ",\"erro\":" + J(erro) +
                   ",\"painel\":" + J(painel) + ",\"raiz\":" + J(RAIZ) + ",\"versao\":" + J(VERSAO) +
                   ",\"nomes\":[" + nomes + "],\"passos\":[" + ps + "]}";
        }
    }

    // discos fixos com espaço livre; o C: vem primeiro (padrão)
    static string Discos()
    {
        StringBuilder b = new StringBuilder("{\"discos\":[");
        bool primeiro = true;
        string atual = InstalacaoAtual();
        List<DriveInfo> lista = new List<DriveInfo>();
        foreach (DriveInfo d in DriveInfo.GetDrives())
        {
            try { if (d.DriveType == DriveType.Fixed && d.IsReady) lista.Add(d); } catch { }
        }
        lista.Sort(delegate (DriveInfo x, DriveInfo y) {
            if (x.Name.StartsWith("C")) return -1; if (y.Name.StartsWith("C")) return 1; return string.Compare(x.Name, y.Name);
        });
        foreach (DriveInfo d in lista)
        {
            string letra = d.Name.Substring(0, 1);
            string rotulo = "";
            try { rotulo = d.VolumeLabel; } catch { }
            if (!primeiro) b.Append(',');
            primeiro = false;
            b.Append("{\"letra\":" + J(letra) + ",\"livreGB\":" + (int)(d.AvailableFreeSpace / 1073741824L) +
                     ",\"totalGB\":" + (int)(d.TotalSize / 1073741824L) + ",\"rotulo\":" + J(rotulo) + "}");
        }
        b.Append("],\"atual\":" + J(atual) + "}");
        return b.ToString();
    }

    static string InstalacaoAtual()
    {
        try
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
            {
                string v = k == null ? null : k.GetValue("PODCAST PRO") as string;
                if (v != null)
                {
                    int i = v.IndexOf(@"\python\pythonw.exe", StringComparison.OrdinalIgnoreCase);
                    if (i > 0) return v.Substring(0, i).Trim('"');
                }
            }
        }
        catch { }
        return "";
    }

    // ------------------------------------------------------------------ instalação
    static void Iniciar()
    {
        lock (trava)
        {
            if (rodando || pronto) return;
            rodando = true; erro = "";
            for (int i = 0; i < 7; i++) if (passos[i] == 3) passos[i] = 0;
        }
        Thread t = new Thread(Instalar);
        t.IsBackground = true;
        t.Start();
    }

    static void Log(string s)
    {
        try { if (log != null) { log.WriteLine(DateTime.Now.ToString("HH:mm:ss") + " " + s); log.Flush(); } } catch { }
    }

    static void Msg(string s, double d) { lock (trava) { msg = s; dentro = d; } }

    static void Instalar()
    {
        int atual = 0;
        try
        {
            Directory.CreateDirectory(RAIZ);
            log = new StreamWriter(Path.Combine(RAIZ, "instalacao.log"), true, new UTF8Encoding(false));
            Log("Instalador v13 (PODCAST PRO " + VERSAO + ") em " + RAIZ);
            Action[] etapas = { CopiarPrograma, InstalarPython, BaixarFFmpeg, InstalarPacotes, BaixarModelo, LigarComWindows, InstalarPainel };
            for (atual = 0; atual < 7; atual++)
            {
                if (cancelado) return;
                if (passos[atual] == 2) continue; // "Tentar de novo" continua de onde parou
                lock (trava) { passos[atual] = 1; dentro = 0; }
                Log("PASSO " + (atual + 1) + " " + NOMES[atual]);
                if (TESTE != null && atual >= 5) { Log("(modo de teste: pulado)"); Msg("Modo de teste: etapa pulada.", 1); }
                else etapas[atual]();
                lock (trava) { passos[atual] = 2; dentro = 0; }
            }
            lock (trava) { pronto = true; msg = "Tudo certo!"; }
            Log("Tudo certo!");
        }
        catch (Exception e)
        {
            string m = e.Message;
            Log("ERRO: " + e);
            lock (trava) { if (atual < 7) passos[atual] = 3; erro = m; }
        }
        finally
        {
            lock (trava) { rodando = false; }
            try { if (log != null) { log.Close(); log = null; } } catch { }
        }
    }

    static byte[] Recurso(string nome)
    {
        Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(nome);
        if (s == null) throw new Exception("arquivo interno faltando: " + nome);
        using (s) using (MemoryStream m = new MemoryStream()) { s.CopyTo(m); return m.ToArray(); }
    }

    static void Gravar(string destino, byte[] dados)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destino));
        string tmp = destino + ".novo";
        File.WriteAllBytes(tmp, dados);
        for (int i = 0; i < 6; i++)
        {
            try { if (File.Exists(destino)) File.Delete(destino); File.Move(tmp, destino); return; }
            catch (IOException) { Thread.Sleep(500); }
            catch (UnauthorizedAccessException) { Thread.Sleep(500); }
        }
        throw new Exception("não consegui gravar " + destino + " (o arquivo está em uso? feche o Premiere e tente de novo)");
    }

    static void CopiarPrograma()
    {
        Msg("Parando o programa local, se estiver ligado...", 0.05);
        if (TESTE == null) PararServidor();
        string[,] arquivos = {
            { "server.py", @"service\server.py" },
            { "requirements.txt", @"service\requirements.txt" },
            { "painel_index.html", @"painel\index.html" },
            { "painel_main.js", @"painel\main.js" },
            { "PODCAST_PRO.ccx", @"PODCAST_PRO.ccx" },
            { "base_modelos.prproj", @"modelos\base_modelos.prproj" },
            { "face_detection_yunet_2023mar.onnx", @"modelos\face_detection_yunet_2023mar.onnx" } };
        int n = arquivos.GetLength(0);
        for (int i = 0; i < n; i++)
        {
            Msg("Copiando " + arquivos[i, 1] + "...", (double)i / (n + 1));
            Gravar(Path.Combine(RAIZ, arquivos[i, 1]), Recurso(arquivos[i, 0]));
        }
        foreach (string nome in Assembly.GetExecutingAssembly().GetManifestResourceNames())
        {
            if (nome.StartsWith("img_") && nome.EndsWith(".png"))
                Gravar(Path.Combine(RAIZ, @"painel\img\" + nome.Substring(4)), Recurso(nome));
        }
        foreach (string pasta in new string[] { "cache", "backup", "mogrts", "estilos", @"cache\criativos", @"cache\overlays" })
            Directory.CreateDirectory(Path.Combine(RAIZ, pasta));
        string bat = "@echo off\r\nfor /f \"tokens=5\" %%a in ('netstat -ano ^| findstr \":8765\" ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1\r\n" +
                     "start \"\" /B \"" + RAIZ + "\\python\\pythonw.exe\" \"" + RAIZ + "\\service\\server.py\"\r\n";
        Gravar(Path.Combine(RAIZ, "REINICIAR_SERVIDOR.bat"), Encoding.Default.GetBytes(bat));
        Msg("Programa copiado.", 1);
    }

    static void PararServidor()
    {
        try
        {
            Rodar("cmd.exe", "/c for /f \"tokens=5\" %a in ('netstat -ano ^| findstr \":8765\" ^| findstr LISTENING') do taskkill /F /PID %a", null, 30000, false);
        }
        catch { }
        Thread.Sleep(800);
    }

    static string Python { get { return Path.Combine(RAIZ, @"python\python.exe"); } }

    static void InstalarPython()
    {
        string pasta = Path.Combine(RAIZ, "python");
        if (File.Exists(Python) && Rodar(Python, "-m pip --version", null, 60000, false) == 0)
        {
            Log("Já instalado."); Msg("O Python já estava instalado.", 1); return;
        }
        string zip = Path.Combine(RAIZ, "python-embed.zip");
        Baixar(URL_PYTHON, zip, "Baixando o Python", 0.0, 0.5);
        Msg("Abrindo o Python...", 0.55);
        if (Directory.Exists(pasta)) { try { Directory.Delete(pasta, true); } catch { } }
        ZipFile.ExtractToDirectory(zip, pasta);
        File.Delete(zip);
        string pth = Path.Combine(pasta, "python312._pth");
        File.WriteAllText(pth, "python312.zip\r\n.\r\nLib\\site-packages\r\nimport site\r\n", new UTF8Encoding(false));
        string getpip = Path.Combine(RAIZ, "get-pip.py");
        Baixar(URL_PIP, getpip, "Baixando o instalador de pacotes (pip)", 0.6, 0.8);
        Msg("Instalando o pip...", 0.85);
        if (Rodar(Python, "\"" + getpip + "\" --no-warn-script-location", RAIZ, 600000, true) != 0)
            throw new Exception("não consegui instalar o pip (veja " + RAIZ + "\\instalacao.log)");
        try { File.Delete(getpip); } catch { }
        Msg("Python pronto.", 1);
    }

    static void BaixarFFmpeg()
    {
        string pasta = Path.Combine(RAIZ, "ffmpeg");
        if (File.Exists(Path.Combine(pasta, "ffmpeg.exe")) && File.Exists(Path.Combine(pasta, "ffprobe.exe")))
        {
            Log("Já instalado."); Msg("O FFmpeg já estava instalado.", 1); return;
        }
        string zip = Path.Combine(RAIZ, "ffmpeg.zip");
        Exception ultimo = null;
        foreach (string url in URLS_FFMPEG)
        {
            try { Baixar(url, zip, "Baixando o FFmpeg", 0.0, 0.85); ultimo = null; break; }
            catch (Exception e) { ultimo = e; Log("FFmpeg: " + url + " falhou: " + e.Message); }
        }
        if (ultimo != null) throw ultimo;
        Msg("Abrindo o FFmpeg...", 0.9);
        Directory.CreateDirectory(pasta);
        using (ZipArchive z = ZipFile.OpenRead(zip))
        {
            foreach (ZipArchiveEntry e in z.Entries)
            {
                string nome = e.Name.ToLower();
                if (nome == "ffmpeg.exe" || nome == "ffprobe.exe") e.ExtractToFile(Path.Combine(pasta, nome), true);
            }
        }
        File.Delete(zip);
        if (!File.Exists(Path.Combine(pasta, "ffmpeg.exe"))) throw new Exception("o FFmpeg baixado não tinha o ffmpeg.exe");
        Msg("FFmpeg pronto.", 1);
    }

    static void InstalarPacotes()
    {
        Msg("Instalando os pacotes de áudio e inteligência (pode levar alguns minutos)...", 0.05);
        string req = Path.Combine(RAIZ, @"service\requirements.txt");
        int r = Rodar(Python, "-m pip install --no-warn-script-location --disable-pip-version-check -r \"" + req + "\"", RAIZ, 3600000, true);
        if (r != 0) throw new Exception("a instalação dos pacotes falhou (veja " + RAIZ + "\\instalacao.log)");
        Msg("Pacotes instalados.", 1);
    }

    static void BaixarModelo()
    {
        Msg("Baixando o modelo da busca por sentido...", 0.1);
        string cod = "from fastembed import TextEmbedding; list(TextEmbedding('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2', cache_dir=r'" +
                     Path.Combine(RAIZ, "modelos") + "').embed(['teste']))";
        if (Rodar(Python, "-c \"" + cod + "\"", RAIZ, 1800000, true) != 0)
            Log("Aviso: o modelo da busca não baixou agora; o programa baixa sozinho no primeiro uso.");
        Msg("Modelo pronto.", 1);
    }

    static void LigarComWindows()
    {
        string pyw = Path.Combine(RAIZ, @"python\pythonw.exe");
        string srv = Path.Combine(RAIZ, @"service\server.py");
        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
            k.SetValue("PODCAST PRO", "\"" + pyw + "\" \"" + srv + "\"", RegistryValueKind.String);
        Msg("Criando o atalho na área de trabalho...", 0.3);
        string ps = "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\\" + NOME_ATALHO +
                    ".lnk'); $s.TargetPath='" + Path.Combine(RAIZ, "REINICIAR_SERVIDOR.bat") + "'; $s.WorkingDirectory='" + RAIZ + "'; $s.Save()";
        Rodar("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -Command \"" + ps + "\"", null, 60000, false);
        Msg("Ligando o programa local...", 0.5);
        PararServidor();
        ProcessStartInfo si = new ProcessStartInfo(pyw, "\"" + srv + "\"");
        si.WorkingDirectory = Path.Combine(RAIZ, "service");
        si.UseShellExecute = false; si.CreateNoWindow = true;
        Process.Start(si);
        for (int i = 0; i < 40; i++)
        {
            Thread.Sleep(1000);
            try
            {
                using (WebClient w = new WebClient())
                {
                    string r = w.DownloadString("http://127.0.0.1:8765/ping");
                    if (r.Contains("\"ok\"")) { Log("Servidor ligado."); Msg("Programa local ligado.", 1); return; }
                }
            }
            catch { }
        }
        Log("Aviso: o servidor não respondeu; veja " + RAIZ + "\\servidor.log");
        Msg("O programa local demorou a responder (ele liga sozinho com o Windows).", 1);
    }

    static void InstalarPainel()
    {
        string ccx = Path.Combine(RAIZ, "PODCAST_PRO.ccx");
        if (File.Exists(UPIA))
        {
            Msg("Instalando o painel no Premiere...", 0.3);
            if (Rodar(UPIA, "--install \"" + ccx + "\"", null, 300000, true) == 0) { Log("Painel instalado."); Msg("Painel instalado.", 1); return; }
        }
        Log("Painel: abrindo o instalador de plugins da Adobe.");
        lock (trava) { painel = "manual"; }
        try { Process.Start(ccx); } catch { }
        Msg("Confirme a instalação do painel na janela da Adobe.", 1);
    }

    // ------------------------------------------------------------------ utilidades
    static void Baixar(string url, string destino, string texto, double de, double ate)
    {
        Exception ultimo = null;
        for (int tent = 1; tent <= 3; tent++)
        {
            try
            {
                HttpWebRequest rq = (HttpWebRequest)WebRequest.Create(url);
                rq.UserAgent = "PODCAST-PRO-instalador";
                rq.Timeout = 60000; rq.ReadWriteTimeout = 60000;
                using (HttpWebResponse rs = (HttpWebResponse)rq.GetResponse())
                using (Stream s = rs.GetResponseStream())
                using (FileStream f = File.Create(destino))
                {
                    long total = rs.ContentLength, feito = 0;
                    byte[] buf = new byte[1 << 16];
                    int n;
                    DateTime ult = DateTime.MinValue;
                    while ((n = s.Read(buf, 0, buf.Length)) > 0)
                    {
                        if (cancelado) throw new Exception("instalação cancelada");
                        f.Write(buf, 0, n);
                        feito += n;
                        if ((DateTime.Now - ult).TotalMilliseconds > 300)
                        {
                            ult = DateTime.Now;
                            double fr = total > 0 ? (double)feito / total : 0.5;
                            Msg(texto + "... " + (feito / 1048576) + (total > 0 ? " de " + (total / 1048576) : "") + " MB", de + (ate - de) * fr);
                        }
                    }
                }
                Log("Baixado: " + url);
                return;
            }
            catch (Exception e)
            {
                ultimo = e;
                Log("Download falhou (" + tent + "): " + url + " - " + e.Message);
                Thread.Sleep(2000 * tent);
            }
        }
        throw new Exception("não consegui baixar " + Path.GetFileName(destino) + ": " + (ultimo == null ? "" : ultimo.Message));
    }

    static int Rodar(string exe, string args, string pasta, int limiteMs, bool registrar)
    {
        ProcessStartInfo si = new ProcessStartInfo(exe, args);
        si.UseShellExecute = false; si.CreateNoWindow = true;
        si.RedirectStandardOutput = true; si.RedirectStandardError = true;
        si.StandardOutputEncoding = Encoding.UTF8; si.StandardErrorEncoding = Encoding.UTF8;
        if (pasta != null) si.WorkingDirectory = pasta;
        using (Process p = new Process())
        {
            p.StartInfo = si;
            DataReceivedEventHandler h = delegate (object o, DataReceivedEventArgs e) {
                if (e.Data == null) return;
                if (registrar) Log(e.Data);
                string d = e.Data.Trim();
                if (d.StartsWith("Collecting ") || d.StartsWith("Downloading ") || d.StartsWith("Installing collected"))
                {
                    lock (trava) { msg = d.Length > 90 ? d.Substring(0, 90) + "..." : d; dentro = Math.Min(0.95, dentro + 0.02); }
                }
            };
            p.OutputDataReceived += h; p.ErrorDataReceived += h;
            p.Start();
            p.BeginOutputReadLine(); p.BeginErrorReadLine();
            if (!p.WaitForExit(limiteMs)) { try { p.Kill(); } catch { } throw new Exception("demorou demais: " + Path.GetFileName(exe)); }
            p.WaitForExit();
            return p.ExitCode;
        }
    }

    // ------------------------------------------------------------------ desinstalar
    static int Desinstalar()
    {
        string raiz = InstalacaoAtual();
        if (raiz == "") raiz = RAIZ;
        try { using (RegistryKey k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true)) { if (k != null) k.DeleteValue("PODCAST PRO", false); } } catch { }
        try { File.Delete(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), NOME_ATALHO + ".lnk")); } catch { }
        RAIZ = raiz;
        PararServidor();
        try { Directory.Delete(raiz, true); } catch { }
        Console.WriteLine("PODCAST PRO removido de " + raiz + " (o painel do Premiere sai pelo Creative Cloud > Plugins).");
        return 0;
    }
}
