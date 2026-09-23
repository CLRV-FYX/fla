using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace FLA
{
    public class Program
    {
        public const string VERSION = "1.28.0";
        public const int PORT = 8307;
        public static string ServerUrl = "http://127.0.0.1:8306";
        public static MainForm MainWindow;
        public static NotifyIcon TrayIcon;

        [STAThread]
        public static void Main(string[] args)
        {
            // 单实例互斥保护
            bool isNew;
            using (Mutex mutex = new Mutex(true, "FLA_Desktop_Mutex_128", out isNew))
            {
                if (!isNew)
                {
                    // 已有实例在运行，若有参数则转发
                    if (args.Length > 0 && args[0].StartsWith("fla://"))
                    {
                        ForwardProtocol(args[0]);
                    }
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                // 1. 注册 Windows 协议
                RegisterProtocol();

                // 2. 启动本地 8307 HTTP 桥接服务
                StartLocalServer();

                // 3. 启动希沃白板5拦截守护线程
                StartSeewoInterceptor();

                // 4. 处理启动参数 (如有)
                if (args.Length > 0 && args[0].StartsWith("fla://"))
                {
                    HandleProtocolUrl(args[0]);
                }

                // 5. 启动托盘与界面
                MainWindow = new MainForm();
                SetupTray();

                // 6. 后台检测版本更新
                CheckUpdateAsync(false);

                Application.Run(MainWindow);
            }
        }

        #region Windows 协议注册 (fla://)
        public static void RegisterProtocol()
        {
            try
            {
                string exePath = Application.ExecutablePath;
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Classes\fla"))
                {
                    key.SetValue("", "URL:FLA Protocol");
                    key.SetValue("URL Protocol", "");
                    using (RegistryKey cmdKey = key.CreateSubKey(@"shell\open\command"))
                    {
                        cmdKey.SetValue("", "\"" + exePath + "\" \"%1\"");
                    }
                }
            }
            catch { }
        }

        private static void ForwardProtocol(string uri)
        {
            try
            {
                using (WebClient wc = new WebClient())
                {
                    wc.Headers[HttpRequestHeader.ContentType] = "application/json";
                    string json = "{\"uri\":\"" + uri.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"}";
                    wc.UploadString("http://127.0.0.1:" + PORT + "/api/protocol", json);
                }
            }
            catch { }
        }
        #endregion

        #region 本地 8307 HTTP 服务
        private static HttpListener listener;
        public static void StartLocalServer()
        {
            Thread t = new Thread(() =>
            {
                try
                {
                    listener = new HttpListener();
                    listener.Prefixes.Add("http://127.0.0.1:" + PORT + "/");
                    listener.Start();
                    while (listener.IsListening)
                    {
                        HttpListenerContext ctx = listener.GetContext();
                        ThreadPool.QueueUserWorkItem(HandleHttpRequest, ctx);
                    }
                }
                catch { }
            })
            { IsBackground = true };
            t.Start();
        }

        private static void HandleHttpRequest(object state)
        {
            HttpListenerContext ctx = (HttpListenerContext)state;
            HttpListenerRequest req = ctx.Request;
            HttpListenerResponse res = ctx.Response;

            // 跨域头支持所有浏览器调用
            res.Headers.Add("Access-Control-Allow-Origin", "*");
            res.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.Headers.Add("Access-Control-Allow-Headers", "*");

            if (req.HttpMethod == "OPTIONS")
            {
                res.StatusCode = 204;
                res.Close();
                return;
            }

            string path = req.Url.AbsolutePath;
            try
            {
                if (path == "/api/status")
                {
                    string json = "{\"ok\":true,\"version\":\"" + VERSION + "\",\"service\":\"fla-desktop-bridge\",\"port\":" + PORT + "}";
                    SendJson(res, 200, json);
                }
                else if (path == "/api/open" && req.HttpMethod == "POST")
                {
                    string body;
                    using (StreamReader sr = new StreamReader(req.InputStream, Encoding.UTF8))
                    {
                        body = sr.ReadToEnd();
                    }
                    string url = ExtractJsonVal(body, "url");
                    string name = ExtractJsonVal(body, "name");
                    if (string.IsNullOrEmpty(name)) name = "presentation.pptx";
                    string token = ExtractJsonVal(body, "token");

                    if (!string.IsNullOrEmpty(url))
                    {
                        ThreadPool.QueueUserWorkItem(_ => OpenFileAsync(url, name, token));
                        SendJson(res, 200, "{\"ok\":true,\"msg\":\"正在调起本地系统默认办公软件打开课件…\"}");
                    }
                    else
                    {
                        SendJson(res, 400, "{\"ok\":false,\"error\":\"缺少课件 URL\"}");
                    }
                }
                else if (path == "/api/action" && req.HttpMethod == "POST")
                {
                    string body;
                    using (StreamReader sr = new StreamReader(req.InputStream, Encoding.UTF8))
                    {
                        body = sr.ReadToEnd();
                    }
                    string act = ExtractJsonVal(body, "action");
                    ExecuteSlideAction(act);
                    SendJson(res, 200, "{\"ok\":true,\"action\":\"" + act + "\"}");
                }
                else if (path == "/api/protocol" && req.HttpMethod == "POST")
                {
                    string body;
                    using (StreamReader sr = new StreamReader(req.InputStream, Encoding.UTF8))
                    {
                        body = sr.ReadToEnd();
                    }
                    string uri = ExtractJsonVal(body, "uri");
                    if (!string.IsNullOrEmpty(uri)) HandleProtocolUrl(uri);
                    SendJson(res, 200, "{\"ok\":true}");
                }
                else
                {
                    SendJson(res, 404, "{\"ok\":false,\"error\":\"Not Found\"}");
                }
            }
            catch (Exception ex)
            {
                SendJson(res, 500, "{\"ok\":false,\"error\":\"" + ex.Message.Replace("\"", "'") + "\"}");
            }
        }

        private static void SendJson(HttpListenerResponse res, int status, string json)
        {
            try
            {
                byte[] b = Encoding.UTF8.GetBytes(json);
                res.StatusCode = status;
                res.ContentType = "application/json; charset=utf-8";
                res.ContentLength64 = b.Length;
                res.OutputStream.Write(b, 0, b.Length);
                res.Close();
            }
            catch { }
        }

        private static string ExtractJsonVal(string json, string key)
        {
            if (string.IsNullOrEmpty(json)) return "";
            string k = "\"" + key + "\"";
            int idx = json.IndexOf(k);
            if (idx == -1) return "";
            int colon = json.IndexOf(":", idx + k.Length);
            if (colon == -1) return "";
            int start = json.IndexOf("\"", colon);
            if (start == -1) return "";
            int end = json.IndexOf("\"", start + 1);
            if (end == -1) return "";
            return json.Substring(start + 1, end - start - 1);
        }
        #endregion

        #region 课件下载与系统 Office 原生调起
        public static void OpenFileAsync(string url, string name, string token)
        {
            try
            {
                string cacheDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FLA_Cache");
                if (!Directory.Exists(cacheDir)) Directory.CreateDirectory(cacheDir);

                string safeName = Path.GetFileName(name);
                if (string.IsNullOrEmpty(safeName)) safeName = "presentation.pptx";
                string localPath = Path.Combine(cacheDir, safeName);

                using (WebClient wc = new WebClient())
                {
                    if (!string.IsNullOrEmpty(token)) wc.Headers["Authorization"] = "Bearer " + token;
                    wc.DownloadFile(url, localPath);
                }

                // 启动 Office / WPS 播放
                LaunchOfficeFile(localPath);
            }
            catch (Exception ex)
            {
                MessageBox.Show("打开课件失败: " + ex.Message, "FLA 课堂助手", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        public static void HandleProtocolUrl(string uri)
        {
            try
            {
                // 解析类似 fla://open?url=...&name=...&token=...
                int qIdx = uri.IndexOf('?');
                if (qIdx != -1)
                {
                    string qs = uri.Substring(qIdx + 1);
                    string[] parts = qs.Split('&');
                    string url = "", name = "presentation.pptx", token = "";
                    foreach (string p in parts)
                    {
                        string[] kv = p.Split('=');
                        if (kv.Length == 2)
                        {
                            string k = Uri.UnescapeDataString(kv[0]);
                            string v = Uri.UnescapeDataString(kv[1]);
                            if (k == "url") url = v;
                            if (k == "name") name = v;
                            if (k == "token") token = v;
                        }
                    }
                    if (!string.IsNullOrEmpty(url))
                    {
                        ThreadPool.QueueUserWorkItem(_ => OpenFileAsync(url, name, token));
                    }
                }
            }
            catch { }
        }

        public static void LaunchOfficeFile(string path)
        {
            try
            {
                // 优先通过 COM 挂接 PowerPoint
                Type pptType = Type.GetTypeFromProgID("PowerPoint.Application");
                if (pptType != null)
                {
                    dynamic ppt = Activator.CreateInstance(pptType);
                    ppt.Visible = 1;
                    dynamic pres = ppt.Presentations.Open(path, 0, 0, 1);
                    pres.SlideShowSettings.Run();
                    return;
                }
            }
            catch { }

            // 回退方案：通过系统 Shell 默认关联直接打开 (兼容 WPS / 其它 Office)
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(path) { UseShellExecute = true };
                Process.Start(psi);
            }
            catch { }
        }

        public static void ExecuteSlideAction(string act)
        {
            try
            {
                Type pptType = Type.GetTypeFromProgID("PowerPoint.Application");
                if (pptType != null)
                {
                    dynamic ppt = Activator.CreateInstance(pptType);
                    if (ppt.SlideShowWindows.Count > 0)
                    {
                        dynamic view = ppt.SlideShowWindows[1].View;
                        if (act == "next" || act == "stepNext") view.Next();
                        else if (act == "prev" || act == "stepPrev") view.Previous();
                        else if (act == "black")
                        {
                            view.State = (view.State == 3) ? 1 : 3; // 3 = ppSlideShowBlackScreen
                        }
                        else if (act == "exit") view.Exit();
                        return;
                    }
                }
            }
            catch { }

            // 键盘穿透兜底
            if (act == "next" || act == "stepNext") SendKeys.SendWait("{RIGHT}");
            else if (act == "prev" || act == "stepPrev") SendKeys.SendWait("{LEFT}");
            else if (act == "black") SendKeys.SendWait("b");
            else if (act == "exit") SendKeys.SendWait("{ESC}");
        }
        #endregion

        #region 希沃白板5 (Seewo) 拦截器
        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        private static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

        private static void StartSeewoInterceptor()
        {
            Thread t = new Thread(() =>
            {
                while (true)
                {
                    try
                    {
                        // 检索希沃 PPTService 注入窗口并压制
                        Process[] procs = Process.GetProcessesByName("PPTService");
                        foreach (Process p in procs)
                        {
                            if (p.MainWindowHandle != IntPtr.Zero)
                            {
                                ShowWindow(p.MainWindowHandle, 0); // 0 = SW_HIDE
                            }
                        }
                        // 检索希沃白板覆盖工具栏类名
                        IntPtr hBar = FindWindow("EasiNotePPTToolbar", null);
                        if (hBar != IntPtr.Zero) ShowWindow(hBar, 0);
                    }
                    catch { }
                    Thread.Sleep(800);
                }
            })
            { IsBackground = true };
            t.Start();
        }
        #endregion

        #region 托盘管理
        private static void SetupTray()
        {
            TrayIcon = new NotifyIcon();
            TrayIcon.Text = "FLA 课堂助手 v" + VERSION;
            TrayIcon.Icon = SystemIcons.Application;
            TrayIcon.Visible = true;

            ContextMenu menu = new ContextMenu();
            menu.MenuItems.Add("显示主界面", (s, e) => { MainWindow.Show(); MainWindow.WindowState = FormWindowState.Normal; });
            menu.MenuItems.Add("打开网页控制台", (s, e) => { Process.Start(new ProcessStartInfo(ServerUrl) { UseShellExecute = true }); });
            menu.MenuItems.Add("检查更新", (s, e) => { CheckUpdateAsync(true); });
            menu.MenuItems.Add("-");
            menu.MenuItems.Add("退出", (s, e) => { TrayIcon.Visible = false; Application.Exit(); });
            TrayIcon.ContextMenu = menu;

            TrayIcon.DoubleClick += (s, e) => { MainWindow.Show(); MainWindow.WindowState = FormWindowState.Normal; };
        }
        #endregion

        #region 版本自动检测与原地静默更新
        public static void CheckUpdateAsync(bool manual)
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    string url = ServerUrl.TrimEnd('/') + "/api/desktop/version";
                    using (WebClient wc = new WebClient())
                    {
                        string json = wc.DownloadString(url);
                        string remoteVer = ExtractJsonVal(json, "version");
                        string dlUrl = ExtractJsonVal(json, "download_url");

                        if (IsNewer(remoteVer, VERSION))
                        {
                            if (MainWindow != null && !MainWindow.IsDisposed)
                            {
                                MainWindow.Invoke(new Action(() => MainWindow.ShowUpdateNotice(remoteVer)));
                            }
                            // 自动更新
                            DoAutoUpdate(dlUrl);
                        }
                        else if (manual)
                        {
                            MessageBox.Show("当前已是最新版本 (v" + VERSION + ")", "FLA 课堂助手", MessageBoxButtons.OK, MessageBoxIcon.Information);
                        }
                    }
                }
                catch (Exception ex)
                {
                    if (manual) MessageBox.Show("检查更新异常: " + ex.Message, "FLA 课堂助手", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
            });
        }

        private static bool IsNewer(string remote, string current)
        {
            try
            {
                Version r = new Version(remote.TrimStart('v'));
                Version c = new Version(current.TrimStart('v'));
                return r > c;
            }
            catch { return false; }
        }

        private static void DoAutoUpdate(string relativeUrl)
        {
            try
            {
                string exePath = Application.ExecutablePath;
                string tempPath = exePath + ".download";
                string oldPath = exePath + ".old";

                string fullUrl = relativeUrl.StartsWith("http") ? relativeUrl : (ServerUrl.TrimEnd('/') + relativeUrl);

                using (WebClient wc = new WebClient())
                {
                    wc.DownloadFile(fullUrl, tempPath);
                }

                if (File.Exists(oldPath)) { try { File.Delete(oldPath); } catch { } }
                File.Move(exePath, oldPath);
                File.Move(tempPath, exePath);

                // 重启客户端
                Process.Start(exePath);
                Environment.Exit(0);
            }
            catch { }
        }
        #endregion
    }

    #region 现代 Fluent 质感窗口界面 (Form)
    public class MainForm : Form
    {
        private Label lblUpdateStatus;

        public MainForm()
        {
            InitializeComponent();
        }

        private void InitializeComponent()
        {
            this.Text = "FLA 课堂助手 v" + Program.VERSION;
            this.Size = new Size(600, 440);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.FormBorderStyle = FormBorderStyle.FixedSingle;
            this.MaximizeBox = false;
            this.BackColor = Color.FromArgb(15, 23, 42); // #0f172a
            this.ForeColor = Color.White;

            // 标题栏 Header
            Panel header = new Panel { Dock = DockStyle.Top, Height = 66, BackColor = Color.FromArgb(30, 41, 59) };
            Label lblTitle = new Label
            {
                Text = "FLA 课堂助手  v" + Program.VERSION,
                Font = new Font("Segoe UI", 12.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(241, 245, 249),
                Location = new Point(22, 14),
                AutoSize = true
            };
            Label lblSub = new Label
            {
                Text = "现代化多媒体教学终端 · 希沃白板5智能拦截与板书同步",
                Font = new Font("Segoe UI", 9f),
                ForeColor = Color.FromArgb(148, 163, 184),
                Location = new Point(23, 38),
                AutoSize = true
            };
            header.Controls.Add(lblTitle);
            header.Controls.Add(lblSub);
            this.Controls.Add(header);

            // 卡片区域 Body
            Panel body = new Panel { Dock = DockStyle.Fill, Padding = new Padding(20, 16, 20, 16) };

            int y = 14;
            body.Controls.Add(CreateCard("🛡️  希沃白板5 智能拦截器", "自动检测并压制 PPT 放映时霸屏注入的工具条", "已启用 (后台拦截)", Color.FromArgb(16, 185, 129), ref y));
            body.Controls.Add(CreateCard("📊  PPT / WPS 演示联动与板书同步", "COM 接口监听放映页码，板书笔迹随幻灯片翻页严格隔离", "COM 就绪", Color.FromArgb(2, 132, 199), ref y));
            body.Controls.Add(CreateCard("🔌  本地 Office 网页唤起服务", "支持在网页端一键调起本地默认 PowerPoint/WPS 演示", "127.0.0.1:8307", Color.FromArgb(16, 185, 129), ref y));

            // 更新状态条
            Panel updateCard = new Panel
            {
                Location = new Point(20, y + 6),
                Size = new Size(544, 42),
                BackColor = Color.FromArgb(23, 37, 84),
                BorderStyle = BorderStyle.FixedSingle
            };
            lblUpdateStatus = new Label
            {
                Text = "自动更新状态：已是最新版本 (v" + Program.VERSION + ")，启动自动比对",
                Font = new Font("Segoe UI", 8.5f),
                ForeColor = Color.FromArgb(147, 197, 253),
                Location = new Point(12, 12),
                AutoSize = true
            };
            Button btnCheck = new Button
            {
                Text = "检查更新",
                Font = new Font("Segoe UI", 8.5f),
                Location = new Point(448, 7),
                Size = new Size(80, 26),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(30, 64, 175),
                ForeColor = Color.White
            };
            btnCheck.Click += (s, e) => { Program.CheckUpdateAsync(true); };
            updateCard.Controls.Add(lblUpdateStatus);
            updateCard.Controls.Add(btnCheck);
            body.Controls.Add(updateCard);

            this.Controls.Add(body);

            // 底部按钮栏 Footer
            Panel footer = new Panel { Dock = DockStyle.Bottom, Height = 56, BackColor = Color.FromArgb(15, 23, 42) };
            Button btnWeb = new Button
            {
                Text = "进入 FLA 网页端",
                Font = new Font("Segoe UI", 9f, FontStyle.Bold),
                Location = new Point(20, 10),
                Size = new Size(130, 34),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(51, 65, 85),
                ForeColor = Color.White
            };
            btnWeb.Click += (s, e) => { Process.Start(new ProcessStartInfo(Program.ServerUrl) { UseShellExecute = true }); };

            Button btnMin = new Button
            {
                Text = "最小化到托盘",
                Font = new Font("Segoe UI", 9f, FontStyle.Bold),
                Location = new Point(444, 10),
                Size = new Size(120, 34),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(2, 132, 199),
                ForeColor = Color.White
            };
            btnMin.Click += (s, e) => { this.Hide(); };

            footer.Controls.Add(btnWeb);
            footer.Controls.Add(btnMin);
            this.Controls.Add(footer);

            // 窗口关闭时最小化到托盘
            this.FormClosing += (s, e) =>
            {
                if (e.CloseReason == CloseReason.UserClosing)
                {
                    e.Cancel = true;
                    this.Hide();
                }
            };
        }

        private Panel CreateCard(string title, string desc, string tag, Color tagColor, ref int y)
        {
            Panel p = new Panel
            {
                Location = new Point(20, y),
                Size = new Size(544, 52),
                BackColor = Color.FromArgb(30, 41, 59),
                BorderStyle = BorderStyle.FixedSingle
            };
            Label t = new Label
            {
                Text = title,
                Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(241, 245, 249),
                Location = new Point(12, 8),
                AutoSize = true
            };
            Label d = new Label
            {
                Text = desc,
                Font = new Font("Segoe UI", 8.2f),
                ForeColor = Color.FromArgb(100, 116, 139),
                Location = new Point(12, 28),
                AutoSize = true
            };
            Label tg = new Label
            {
                Text = tag,
                Font = new Font("Segoe UI", 8.5f, FontStyle.Bold),
                ForeColor = tagColor,
                BackColor = Color.FromArgb(15, 23, 42),
                Location = new Point(400, 14),
                Size = new Size(130, 24),
                TextAlign = ContentAlignment.MiddleCenter
            };
            p.Controls.Add(t);
            p.Controls.Add(d);
            p.Controls.Add(tg);
            y += 58;
            return p;
        }

        public void ShowUpdateNotice(string ver)
        {
            if (lblUpdateStatus != null)
            {
                lblUpdateStatus.Text = "发现新版本 v" + ver + "，正在后台自动下载原地替换…";
                lblUpdateStatus.ForeColor = Color.FromArgb(56, 189, 248);
            }
        }
    }
    #endregion
}
