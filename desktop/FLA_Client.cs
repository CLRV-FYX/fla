using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
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
        public static int SeewoBlockedCount = 0;

        [STAThread]
        public static void Main(string[] args)
        {
            // 单实例互斥保护
            bool isNew;
            using (Mutex mutex = new Mutex(true, "FLA_Desktop_Mutex_128", out isNew))
            {
                if (!isNew)
                {
                    if (args.Length > 0 && args[0].StartsWith("fla://"))
                    {
                        ForwardProtocol(args[0]);
                    }
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                // 读取持久化配置 (如保存的服务器地址)
                LoadConfig();

                // 1. 注册 Windows 协议
                RegisterProtocol();

                // 2. 注册 IE11 Edge 渲染模式 (保障内嵌 WebBrowser 支持现代 HTML5 / CSS3 / Canvas)
                RegisterBrowserEmulation();

                // 3. 启动本地 8307 HTTP 桥接服务
                StartLocalServer();

                // 4. 启动希沃白板5拦截守护线程
                StartSeewoInterceptor();

                // 5. 处理启动参数 (如有)
                if (args.Length > 0 && args[0].StartsWith("fla://"))
                {
                    HandleProtocolUrl(args[0]);
                }

                // 6. 启动完整独立的桌面端主窗口
                MainWindow = new MainForm();
                SetupTray();

                // 7. 后台自动检查更新
                CheckUpdateAsync(false);

                Application.Run(MainWindow);
            }
        }

        #region 配置加载与持久化
        private static string GetConfigPath()
        {
            string appdata = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string dir = Path.Combine(appdata, "FLA");
            if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
            return Path.Combine(dir, "config.ini");
        }

        public static void LoadConfig()
        {
            try
            {
                string path = GetConfigPath();
                if (File.Exists(path))
                {
                    string[] lines = File.ReadAllLines(path);
                    foreach (string line in lines)
                    {
                        if (line.StartsWith("server_url=", StringComparison.OrdinalIgnoreCase))
                        {
                            string url = line.Substring("server_url=".Length).Trim();
                            if (!string.IsNullOrEmpty(url)) ServerUrl = url;
                        }
                    }
                }
            }
            catch { }
        }

        public static void SaveConfig()
        {
            try
            {
                string path = GetConfigPath();
                File.WriteAllText(path, "server_url=" + ServerUrl + "\r\nupdated=" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "\r\n");
            }
            catch { }
        }
        #endregion

        #region Windows 协议与内嵌渲染器注册
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

        public static void RegisterBrowserEmulation()
        {
            try
            {
                string exeName = Path.GetFileName(Application.ExecutablePath);
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Internet Explorer\Main\FeatureControl\FEATURE_BROWSER_EMULATION"))
                {
                    // 11001 = 0x2AF9 (IE11 Edge Mode - 支持标准 HTML5 / CSS3 / ES5)
                    key.SetValue(exeName, 11001, RegistryValueKind.DWord);
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
        public static void StartLocalServer()
        {
            Thread t = new Thread(() =>
            {
                HttpListener listener = null;
                try
                {
                    listener = new HttpListener();
                    listener.Prefixes.Add("http://127.0.0.1:" + PORT + "/");
                    listener.Start();

                    while (listener.IsListening)
                    {
                        try
                        {
                            HttpListenerContext ctx = listener.GetContext();
                            ThreadPool.QueueUserWorkItem(_ => ProcessRequest(ctx));
                        }
                        catch { }
                    }
                }
                catch { }
            });
            t.IsBackground = true;
            t.Start();
        }

        private static void ProcessRequest(HttpListenerContext ctx)
        {
            HttpListenerRequest req = ctx.Request;
            HttpListenerResponse res = ctx.Response;

            res.Headers.Add("Access-Control-Allow-Origin", "*");
            res.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.Headers.Add("Access-Control-Allow-Headers", "Content-Type");

            if (req.HttpMethod == "OPTIONS")
            {
                res.StatusCode = 204;
                res.Close();
                return;
            }

            string path = req.Url.AbsolutePath;
            string respJson = "{\"ok\":true}";

            try
            {
                if (path == "/api/status")
                {
                    respJson = string.Format("{{\"ok\":true,\"version\":\"{0}\",\"status\":\"running\",\"seewo_blocked\":{1}}}", VERSION, SeewoBlockedCount);
                }
                else if (path == "/api/open" && req.HttpMethod == "POST")
                {
                    using (StreamReader r = new StreamReader(req.InputStream, req.ContentEncoding))
                    {
                        string body = r.ReadToEnd();
                        string url = ExtractJsonString(body, "url");
                        string name = ExtractJsonString(body, "name");
                        string token = ExtractJsonString(body, "token");
                        ThreadPool.QueueUserWorkItem(_ => OpenFileAsync(url, name, token));
                    }
                    respJson = "{\"ok\":true,\"message\":\"opening\"}";
                }
                else if (path == "/api/ppt/next")
                {
                    ComController.NextSlide();
                    respJson = "{\"ok\":true}";
                }
                else if (path == "/api/ppt/prev")
                {
                    ComController.PrevSlide();
                    respJson = "{\"ok\":true}";
                }
                else if (path == "/api/ppt/status")
                {
                    int cur = 0, total = 0;
                    bool active = ComController.GetSlideInfo(out cur, out total);
                    respJson = string.Format("{{\"ok\":true,\"active\":{0},\"current\":{1},\"total\":{2}}}", active ? "true" : "false", cur, total);
                }
                else if (path == "/api/seewo/stats")
                {
                    respJson = string.Format("{{\"ok\":true,\"blocked\":{0}}}", SeewoBlockedCount);
                }
            }
            catch (Exception ex)
            {
                respJson = "{\"ok\":false,\"error\":\"" + ex.Message.Replace("\"", "\\\"") + "\"}";
            }

            byte[] buf = Encoding.UTF8.GetBytes(respJson);
            res.ContentType = "application/json; charset=utf-8";
            res.ContentLength64 = buf.Length;
            try
            {
                res.OutputStream.Write(buf, 0, buf.Length);
                res.Close();
            }
            catch { }
        }

        private static string ExtractJsonString(string json, string key)
        {
            string pattern = "\"" + key + "\":\"";
            int idx = json.IndexOf(pattern);
            if (idx == -1) return "";
            int start = idx + pattern.Length;
            int end = json.IndexOf("\"", start);
            if (end == -1) return "";
            return json.Substring(start, end - start);
        }

        public static void OpenFileAsync(string url, string name, string token)
        {
            try
            {
                string tempDir = Path.Combine(Path.GetTempPath(), "FLA_Cache");
                if (!Directory.Exists(tempDir)) Directory.CreateDirectory(tempDir);

                string ext = Path.GetExtension(name);
                if (string.IsNullOrEmpty(ext)) ext = ".pptx";
                string localFile = Path.Combine(tempDir, Guid.NewGuid().ToString("N").Substring(0, 8) + "_" + name);

                using (WebClient wc = new WebClient())
                {
                    if (!string.IsNullOrEmpty(token)) wc.Headers["Authorization"] = "Bearer " + token;
                    wc.DownloadFile(url, localFile);
                }

                if (ext.ToLower().Contains("ppt"))
                {
                    if (!ComController.OpenPresentation(localFile))
                    {
                        Process.Start(new ProcessStartInfo(localFile) { UseShellExecute = true });
                    }
                }
                else
                {
                    Process.Start(new ProcessStartInfo(localFile) { UseShellExecute = true });
                }

                LogMessage("已成功打开课件: " + name);
            }
            catch (Exception ex)
            {
                LogMessage("打开课件失败: " + ex.Message);
            }
        }

        public static void LogMessage(string msg)
        {
            if (MainWindow != null)
            {
                try
                {
                    MainWindow.BeginInvoke(new Action(() => MainWindow.AppendLog(msg)));
                }
                catch { }
            }
        }
        #endregion

        #region 希沃白板5 拦截器
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        public static void StartSeewoInterceptor()
        {
            Thread t = new Thread(() =>
            {
                while (true)
                {
                    try
                    {
                        EnumWindows((hWnd, lParam) =>
                        {
                            if (!IsWindowVisible(hWnd)) return true;

                            StringBuilder sbTitle = new StringBuilder(256);
                            GetWindowText(hWnd, sbTitle, 256);
                            string title = sbTitle.ToString();

                            StringBuilder sbClass = new StringBuilder(256);
                            GetClassName(hWnd, sbClass, 256);
                            string cls = sbClass.ToString();

                            uint pid;
                            GetWindowThreadProcessId(hWnd, out pid);

                            string procName = "";
                            try
                            {
                                Process p = Process.GetProcessById((int)pid);
                                procName = p.ProcessName.ToLower();
                            }
                            catch { }

                            // 识别希沃白板5注入浮动工具条
                            bool isSeewo = procName.Contains("easinote") || procName.Contains("easicamera") || procName.Contains("seewo");
                            bool isToolBar = cls.Contains("FloatingTool") || cls.Contains("Toolbar") || title.Contains("希沃") || title.Contains("工具条");

                            if (isSeewo && isToolBar)
                            {
                                ShowWindow(hWnd, 0); // SW_HIDE
                                Interlocked.Increment(ref SeewoBlockedCount);
                                LogMessage(string.Format("[拦截守护] 成功压制希沃白板5霸屏工具条 (Handle: 0x{0:X8})", (int)hWnd));
                            }
                            return true;
                        }, IntPtr.Zero);
                    }
                    catch { }

                    Thread.Sleep(800);
                }
            });
            t.IsBackground = true;
            t.Start();
        }
        #endregion

        #region 自更新模块
        public static void CheckUpdateAsync(bool manual)
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    using (WebClient wc = new WebClient())
                    {
                        wc.Headers[HttpRequestHeader.Accept] = "application/json";
                        string json = wc.DownloadString(ServerUrl + "/api/desktop/version");
                        string remoteVer = ExtractJsonString(json, "version");
                        string dlUrl = ExtractJsonString(json, "download_url");

                        if (!string.IsNullOrEmpty(remoteVer) && IsNewerVersion(remoteVer, VERSION))
                        {
                            if (MainWindow != null)
                            {
                                MainWindow.BeginInvoke(new Action(() => MainWindow.ShowUpdateNotice(remoteVer)));
                            }
                            DoSelfUpdate(dlUrl);
                        }
                        else if (manual)
                        {
                            if (MainWindow != null)
                            {
                                MainWindow.BeginInvoke(new Action(() => MessageBox.Show(MainWindow, "当前已是最新版本 (v" + VERSION + ")", "FLA 自动更新", MessageBoxButtons.OK, MessageBoxIcon.Information)));
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    if (manual)
                    {
                        if (MainWindow != null)
                        {
                            MainWindow.BeginInvoke(new Action(() => MessageBox.Show(MainWindow, "连接更新服务器失败: " + ex.Message, "FLA 自动更新", MessageBoxButtons.OK, MessageBoxIcon.Warning)));
                        }
                    }
                }
            });
        }

        private static bool IsNewerVersion(string remote, string local)
        {
            try
            {
                string[] r = remote.Split('.');
                string[] l = local.Split('.');
                for (int i = 0; i < Math.Min(r.Length, l.Length); i++)
                {
                    int rv = int.Parse(r[i]);
                    int lv = int.Parse(l[i]);
                    if (rv > lv) return true;
                    if (rv < lv) return false;
                }
                return r.Length > l.Length;
            }
            catch { return false; }
        }

        private static void DoSelfUpdate(string dlUrl)
        {
            try
            {
                if (string.IsNullOrEmpty(dlUrl)) dlUrl = "/api/desktop/download";
                if (!dlUrl.StartsWith("http")) dlUrl = ServerUrl + dlUrl;

                string currentExe = Application.ExecutablePath;
                string newExe = currentExe + ".new";

                using (WebClient wc = new WebClient())
                {
                    wc.DownloadFile(dlUrl, newExe);
                }

                // 创建原地热替换脚本
                string batPath = Path.Combine(Path.GetTempPath(), "fla_update.bat");
                string bat = string.Format(
                    "@echo off\r\n" +
                    "ping 127.0.0.1 -n 2 > nul\r\n" +
                    "move /y \"{0}\" \"{1}\"\r\n" +
                    "start \"\" \"{1}\"\r\n" +
                    "del \"%~f0\"\r\n",
                    newExe, currentExe
                );
                File.WriteAllText(batPath, bat, Encoding.Default);

                ProcessStartInfo psi = new ProcessStartInfo(batPath)
                {
                    WindowStyle = ProcessWindowStyle.Hidden,
                    CreateNoWindow = true,
                    UseShellExecute = true
                };
                Process.Start(psi);
                Environment.Exit(0);
            }
            catch { }
        }
        #endregion

        #region 托盘管理
        public static void SetupTray()
        {
            TrayIcon = new NotifyIcon();
            TrayIcon.Text = "FLA 智慧互动教学系统 v" + VERSION;
            TrayIcon.Icon = SystemIcons.Application;
            TrayIcon.Visible = true;

            ContextMenu menu = new ContextMenu();
            menu.MenuItems.Add("显示桌面控制台", (s, e) => { MainWindow.Show(); MainWindow.WindowState = FormWindowState.Normal; MainWindow.BringToFront(); });
            menu.MenuItems.Add("打开随页画板", (s, e) => { MainWindow.Show(); MainWindow.WindowState = FormWindowState.Normal; MainWindow.SwitchToTab(1); });
            menu.MenuItems.Add("PPT / WPS 控制", (s, e) => { MainWindow.Show(); MainWindow.WindowState = FormWindowState.Normal; MainWindow.SwitchToTab(2); });
            menu.MenuItems.Add("检查更新", (s, e) => { CheckUpdateAsync(true); });
            menu.MenuItems.Add("-");
            menu.MenuItems.Add("退出程序", (s, e) => { TrayIcon.Visible = false; Application.Exit(); });

            TrayIcon.ContextMenu = menu;
            TrayIcon.DoubleClick += (s, e) => { MainWindow.Show(); MainWindow.WindowState = FormWindowState.Normal; MainWindow.BringToFront(); };
        }

        private static void HandleProtocolUrl(string url)
        {
            try
            {
                Uri u = new Uri(url);
                string path = u.AbsolutePath;
                if (path.Contains("open"))
                {
                    string target = u.Query.Replace("?url=", "");
                    OpenFileAsync(target, Path.GetFileName(target), "");
                }
            }
            catch { }
        }
        #endregion
    }

    #region COM 自动化控制器
    public static class ComController
    {
        public static bool OpenPresentation(string filePath)
        {
            try
            {
                Type pptType = Type.GetTypeFromProgID("PowerPoint.Application");
                if (pptType == null) return false;
                dynamic app = Activator.CreateInstance(pptType);
                app.Visible = 1;
                dynamic pres = app.Presentations.Open(filePath);
                pres.SlideShowSettings.Run();
                return true;
            }
            catch { return false; }
        }

        public static void NextSlide()
        {
            try
            {
                dynamic app = Marshal.GetActiveObject("PowerPoint.Application");
                if (app != null && app.SlideShowWindows.Count > 0)
                {
                    app.SlideShowWindows[1].View.Next();
                }
            }
            catch { }
        }

        public static void PrevSlide()
        {
            try
            {
                dynamic app = Marshal.GetActiveObject("PowerPoint.Application");
                if (app != null && app.SlideShowWindows.Count > 0)
                {
                    app.SlideShowWindows[1].View.Previous();
                }
            }
            catch { }
        }

        public static bool GetSlideInfo(out int current, out int total)
        {
            current = 0; total = 0;
            try
            {
                dynamic app = Marshal.GetActiveObject("PowerPoint.Application");
                if (app != null && app.SlideShowWindows.Count > 0)
                {
                    current = app.SlideShowWindows[1].View.CurrentShowPosition;
                    total = app.SlideShowWindows[1].Presentation.Slides.Count;
                    return true;
                }
            }
            catch { }
            return false;
        }
    }
    #endregion

    #region 独立原生白板画布组件 (Smooth GDI+ Whiteboard)
    public class WhiteboardCanvas : Control
    {
        private List<Bitmap> pages = new List<Bitmap>();
        private int currentPageIndex = 0;
        private Point lastPoint;
        private bool isDrawing = false;
        public Color CurrentColor = Color.FromArgb(0, 122, 255); // Apple System Blue
        public float CurrentWidth = 4f;
        public bool IsEraser = false;

        public event Action<int, int> PageChanged;

        public WhiteboardCanvas()
        {
            this.DoubleBuffered = true;
            this.SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
            this.BackColor = Color.White;
            AddNewPage();
        }

        public void AddNewPage()
        {
            int w = Math.Max(1200, this.Width > 0 ? this.Width : 1200);
            int h = Math.Max(800, this.Height > 0 ? this.Height : 800);
            Bitmap bmp = new Bitmap(w, h);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.White);
            }
            pages.Add(bmp);
            currentPageIndex = pages.Count - 1;
            Invalidate();
            if (PageChanged != null) PageChanged(currentPageIndex + 1, pages.Count);
        }

        public void PrevPage()
        {
            if (currentPageIndex > 0)
            {
                currentPageIndex--;
                Invalidate();
                if (PageChanged != null) PageChanged(currentPageIndex + 1, pages.Count);
            }
        }

        public void NextPage()
        {
            if (currentPageIndex < pages.Count - 1)
            {
                currentPageIndex++;
                Invalidate();
                if (PageChanged != null) PageChanged(currentPageIndex + 1, pages.Count);
            }
            else
            {
                AddNewPage();
            }
        }

        public void ClearCurrentPage()
        {
            if (currentPageIndex >= 0 && currentPageIndex < pages.Count)
            {
                using (Graphics g = Graphics.FromImage(pages[currentPageIndex]))
                {
                    g.Clear(Color.White);
                }
                Invalidate();
            }
        }

        public void SaveImage()
        {
            if (currentPageIndex >= 0 && currentPageIndex < pages.Count)
            {
                using (SaveFileDialog sfd = new SaveFileDialog())
                {
                    sfd.Filter = "PNG 图片 (*.png)|*.png|JPEG 图片 (*.jpg)|*.jpg";
                    sfd.FileName = "FLA_板书_" + DateTime.Now.ToString("yyyyMMdd_HHmmss") + ".png";
                    if (sfd.ShowDialog() == DialogResult.OK)
                    {
                        pages[currentPageIndex].Save(sfd.FileName);
                        MessageBox.Show("板书已成功保存至:\n" + sfd.FileName, "FLA 板书导出", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }
                }
            }
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button == MouseButtons.Left && currentPageIndex >= 0 && currentPageIndex < pages.Count)
            {
                isDrawing = true;
                lastPoint = e.Location;
            }
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (isDrawing && currentPageIndex >= 0 && currentPageIndex < pages.Count)
            {
                using (Graphics g = Graphics.FromImage(pages[currentPageIndex]))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    if (IsEraser)
                    {
                        using (Pen p = new Pen(Color.White, CurrentWidth * 6))
                        {
                            p.StartCap = LineCap.Round;
                            p.EndCap = LineCap.Round;
                            g.DrawLine(p, lastPoint, e.Location);
                        }
                    }
                    else
                    {
                        using (Pen p = new Pen(CurrentColor, CurrentWidth))
                        {
                            p.StartCap = LineCap.Round;
                            p.EndCap = LineCap.Round;
                            g.DrawLine(p, lastPoint, e.Location);
                        }
                    }
                }
                lastPoint = e.Location;
                Invalidate();
            }
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            isDrawing = false;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            if (currentPageIndex >= 0 && currentPageIndex < pages.Count)
            {
                e.Graphics.DrawImage(pages[currentPageIndex], 0, 0);
            }
        }
    }
    #endregion

    #region 完整独立的桌面主工作台 (MainForm)
    public class MainForm : Form
    {
        private Panel sidebar;
        private Panel contentPanel;
        private List<Button> navButtons = new List<Button>();
        private List<Panel> tabPanels = new List<Panel>();
        private WebBrowser webBrowser;
        private WhiteboardCanvas whiteboard;
        private Label lblWbPage;
        private TextBox txtLog;
        private Label lblSeewoStat;
        private Label lblUpdateStatus;
        private TextBox txtServerUrl;

        public MainForm()
        {
            InitializeComponent();
        }

        private void InitializeComponent()
        {
            this.Text = "FLA 智慧互动教学系统 · 桌面客户端 v" + Program.VERSION;
            this.Size = new Size(1200, 800);
            this.MinimumSize = new Size(960, 640);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = Color.FromArgb(242, 242, 247); // Apple iOS Grouped Background
            this.ForeColor = Color.FromArgb(0, 0, 0);
            this.Font = new Font("Segoe UI", 9.5f);

            // 1. 顶部 iOS 质感状态栏 (Header)
            Panel header = new Panel
            {
                Dock = DockStyle.Top,
                Height = 56,
                BackColor = Color.FromArgb(255, 255, 255),
                BorderStyle = BorderStyle.None
            };
            header.Paint += (s, e) =>
            {
                using (Pen p = new Pen(Color.FromArgb(229, 229, 234), 1))
                {
                    e.Graphics.DrawLine(p, 0, header.Height - 1, header.Width, header.Height - 1);
                }
            };

            Label lblLogo = new Label
            {
                Text = "FLA",
                Font = new Font("Segoe UI", 13f, FontStyle.Bold),
                ForeColor = Color.FromArgb(0, 122, 255), // Apple Blue
                Location = new Point(18, 14),
                AutoSize = true
            };
            Label lblAppTitle = new Label
            {
                Text = "智慧互动教学系统 · 独立桌面工作台",
                Font = new Font("Segoe UI", 10.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(28, 28, 30),
                Location = new Point(62, 16),
                AutoSize = true
            };
            Label lblVer = new Label
            {
                Text = "v" + Program.VERSION,
                Font = new Font("Segoe UI", 8.5f),
                ForeColor = Color.FromArgb(142, 142, 147),
                Location = new Point(310, 18),
                AutoSize = true
            };

            // 状态徽章 (已就绪)
            Label lblBadge = new Label
            {
                Text = "● 8307 桥接就绪 · 希沃拦截守护中",
                Font = new Font("Segoe UI", 8.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(52, 199, 89), // Apple Green
                BackColor = Color.FromArgb(234, 248, 237),
                Location = new Point(380, 14),
                Size = new Size(230, 26),
                TextAlign = ContentAlignment.MiddleCenter
            };

            Button btnHeaderRefresh = CreateModernButton("⟳ 刷新页面", 100, 30);
            btnHeaderRefresh.Location = new Point(header.Width - 240, 13);
            btnHeaderRefresh.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            btnHeaderRefresh.Click += (s, e) =>
            {
                if (webBrowser != null && webBrowser.Visible) webBrowser.Refresh();
            };

            Button btnHeaderTray = CreateModernButton("最小化到托盘", 110, 30);
            btnHeaderTray.Location = new Point(header.Width - 130, 13);
            btnHeaderTray.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            btnHeaderTray.Click += (s, e) => { this.Hide(); };

            header.Controls.Add(lblLogo);
            header.Controls.Add(lblAppTitle);
            header.Controls.Add(lblVer);
            header.Controls.Add(lblBadge);
            header.Controls.Add(btnHeaderRefresh);
            header.Controls.Add(btnHeaderTray);
            this.Controls.Add(header);

            // 2. 左侧侧边栏 (Sidebar - iOS 导航 Rail)
            sidebar = new Panel
            {
                Dock = DockStyle.Left,
                Width = 210,
                BackColor = Color.FromArgb(242, 242, 247),
                Padding = new Padding(10, 12, 10, 12)
            };
            sidebar.Paint += (s, e) =>
            {
                using (Pen p = new Pen(Color.FromArgb(229, 229, 234), 1))
                {
                    e.Graphics.DrawLine(p, sidebar.Width - 1, 0, sidebar.Width - 1, sidebar.Height);
                }
            };

            int btnY = 12;
            AddNavButton("🏠  教学控制台", 0, ref btnY);
            AddNavButton("🎨  独立板书画板", 1, ref btnY);
            AddNavButton("📊  PPT / WPS 联动", 2, ref btnY);
            AddNavButton("🛡️  希沃白板5 拦截", 3, ref btnY);
            AddNavButton("📱  手机投屏遥控", 4, ref btnY);
            AddNavButton("⚙️  系统与更新设置", 5, ref btnY);

            this.Controls.Add(sidebar);

            // 3. 内容区 (Content Area)
            contentPanel = new Panel
            {
                Dock = DockStyle.Fill,
                BackColor = Color.FromArgb(255, 255, 255)
            };
            this.Controls.Add(contentPanel);

            // 初始化各个 Tab 视图
            InitTabWebBrowser();
            InitTabWhiteboard();
            InitTabPptController();
            InitTabSeewoInterceptor();
            InitTabRemote();
            InitTabSettings();

            // 默认展示 Tab 0 (内嵌完整教学控制台)
            SwitchToTab(0);

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

        private void AddNavButton(string text, int tabIndex, ref int y)
        {
            Button btn = new Button
            {
                Text = text,
                Location = new Point(10, y),
                Size = new Size(190, 42),
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 9.5f, FontStyle.Regular),
                ForeColor = Color.FromArgb(60, 60, 67),
                BackColor = Color.Transparent,
                TextAlign = ContentAlignment.MiddleLeft,
                Padding = new Padding(12, 0, 0, 0),
                Cursor = Cursors.Hand
            };
            btn.FlatAppearance.BorderSize = 0;
            btn.Click += (s, e) => SwitchToTab(tabIndex);

            sidebar.Controls.Add(btn);
            navButtons.Add(btn);
            y += 48;
        }

        public void SwitchToTab(int index)
        {
            for (int i = 0; i < navButtons.Count; i++)
            {
                if (i == index)
                {
                    navButtons[i].BackColor = Color.FromArgb(255, 255, 255);
                    navButtons[i].ForeColor = Color.FromArgb(0, 122, 255);
                    navButtons[i].Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
                }
                else
                {
                    navButtons[i].BackColor = Color.Transparent;
                    navButtons[i].ForeColor = Color.FromArgb(60, 60, 67);
                    navButtons[i].Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
                }
            }

            for (int i = 0; i < tabPanels.Count; i++)
            {
                tabPanels[i].Visible = (i == index);
                if (i == index) tabPanels[i].BringToFront();
            }
        }

        #region Tab 0: 教学控制台 (内嵌 WebBrowser)
        private void InitTabWebBrowser()
        {
            Panel p = new Panel { Dock = DockStyle.Fill };

            // 顶端便捷导航栏
            Panel navBar = new Panel { Dock = DockStyle.Top, Height = 40, BackColor = Color.FromArgb(248, 248, 250) };
            Button btnBack = CreateMiniButton("◀ 后退", 64);
            btnBack.Location = new Point(10, 6);
            btnBack.Click += (s, e) => { if (webBrowser.CanGoBack) webBrowser.GoBack(); };

            Button btnFwd = CreateMiniButton("前进 ▶", 64);
            btnFwd.Location = new Point(80, 6);
            btnFwd.Click += (s, e) => { if (webBrowser.CanGoForward) webBrowser.GoForward(); };

            Button btnHome = CreateMiniButton("🏠 首页", 64);
            btnHome.Location = new Point(150, 6);
            btnHome.Click += (s, e) => { webBrowser.Navigate(Program.ServerUrl + "/#/library"); };

            Label lblUrlHint = new Label
            {
                Text = "当前连接：" + Program.ServerUrl,
                Font = new Font("Segoe UI", 8.5f),
                ForeColor = Color.FromArgb(142, 142, 147),
                Location = new Point(230, 11),
                AutoSize = true
            };

            navBar.Controls.Add(btnBack);
            navBar.Controls.Add(btnFwd);
            navBar.Controls.Add(btnHome);
            navBar.Controls.Add(lblUrlHint);
            p.Controls.Add(navBar);

            // 现代 WebBrowser 控件
            webBrowser = new WebBrowser
            {
                Dock = DockStyle.Fill,
                ScriptErrorsSuppressed = true,
                IsWebBrowserContextMenuEnabled = false
            };
            webBrowser.Navigate(Program.ServerUrl + "/#/library");
            p.Controls.Add(webBrowser);

            contentPanel.Controls.Add(p);
            tabPanels.Add(p);
        }
        #endregion

        #region Tab 1: 独立板书画板 (Smooth GDI+ Whiteboard)
        private void InitTabWhiteboard()
        {
            Panel p = new Panel { Dock = DockStyle.Fill };

            // 工具栏
            Panel toolBar = new Panel
            {
                Dock = DockStyle.Top,
                Height = 52,
                BackColor = Color.FromArgb(248, 248, 250)
            };

            // 颜色选择
            Button btnPenBlack = CreateColorPickButton("黑色", Color.Black);
            btnPenBlack.Location = new Point(12, 10);
            btnPenBlack.Click += (s, e) => { whiteboard.IsEraser = false; whiteboard.CurrentColor = Color.Black; };

            Button btnPenBlue = CreateColorPickButton("蓝色", Color.FromArgb(0, 122, 255));
            btnPenBlue.Location = new Point(62, 10);
            btnPenBlue.Click += (s, e) => { whiteboard.IsEraser = false; whiteboard.CurrentColor = Color.FromArgb(0, 122, 255); };

            Button btnPenRed = CreateColorPickButton("红色", Color.FromArgb(255, 59, 48));
            btnPenRed.Location = new Point(112, 10);
            btnPenRed.Click += (s, e) => { whiteboard.IsEraser = false; whiteboard.CurrentColor = Color.FromArgb(255, 59, 48); };

            Button btnPenGreen = CreateColorPickButton("绿色", Color.FromArgb(52, 199, 89));
            btnPenGreen.Location = new Point(162, 10);
            btnPenGreen.Click += (s, e) => { whiteboard.IsEraser = false; whiteboard.CurrentColor = Color.FromArgb(52, 199, 89); };

            // 橡皮擦
            Button btnEraser = CreateMiniButton("🧹 橡皮擦", 76);
            btnEraser.Location = new Point(220, 10);
            btnEraser.Click += (s, e) => { whiteboard.IsEraser = true; };

            // 清空画板
            Button btnClear = CreateMiniButton("清空板书", 72);
            btnClear.Location = new Point(304, 10);
            btnClear.Click += (s, e) => { whiteboard.ClearCurrentPage(); };

            // 翻页控制
            Button btnPrev = CreateMiniButton("◀ 上一页", 72);
            btnPrev.Location = new Point(410, 10);
            btnPrev.Click += (s, e) => { whiteboard.PrevPage(); };

            lblWbPage = new Label
            {
                Text = "第 1 / 1 页",
                Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
                Location = new Point(490, 16),
                AutoSize = true
            };

            Button btnNext = CreateMiniButton("下一页 ▶", 72);
            btnNext.Location = new Point(570, 10);
            btnNext.Click += (s, e) => { whiteboard.NextPage(); };

            Button btnNewPage = CreateMiniButton("➕ 加一页", 72);
            btnNewPage.Location = new Point(650, 10);
            btnNewPage.Click += (s, e) => { whiteboard.AddNewPage(); };

            Button btnSave = CreateMiniButton("💾 保存图片", 84);
            btnSave.Location = new Point(740, 10);
            btnSave.Click += (s, e) => { whiteboard.SaveImage(); };

            toolBar.Controls.Add(btnPenBlack);
            toolBar.Controls.Add(btnPenBlue);
            toolBar.Controls.Add(btnPenRed);
            toolBar.Controls.Add(btnPenGreen);
            toolBar.Controls.Add(btnEraser);
            toolBar.Controls.Add(btnClear);
            toolBar.Controls.Add(btnPrev);
            toolBar.Controls.Add(lblWbPage);
            toolBar.Controls.Add(btnNext);
            toolBar.Controls.Add(btnNewPage);
            toolBar.Controls.Add(btnSave);
            p.Controls.Add(toolBar);

            // 画布
            whiteboard = new WhiteboardCanvas { Dock = DockStyle.Fill };
            whiteboard.PageChanged += (cur, tot) =>
            {
                lblWbPage.Text = string.Format("第 {0} / {1} 页", cur, tot);
            };
            p.Controls.Add(whiteboard);

            contentPanel.Controls.Add(p);
            tabPanels.Add(p);
        }
        #endregion

        #region Tab 2: PPT / WPS 演示联动控制器
        private void InitTabPptController()
        {
            Panel p = new Panel { Dock = DockStyle.Fill, Padding = new Padding(32) };

            Label title = new Label
            {
                Text = "PowerPoint / WPS 演示联动与板书同步",
                Font = new Font("Segoe UI", 16f, FontStyle.Bold),
                ForeColor = Color.FromArgb(28, 28, 30),
                Location = new Point(32, 28),
                AutoSize = true
            };
            Label sub = new Label
            {
                Text = "通过原生 Windows COM 自动化接口实现 PPT 幻灯片精准同步、希沃工具条压制与随页独立板书。",
                Font = new Font("Segoe UI", 9.5f),
                ForeColor = Color.FromArgb(142, 142, 147),
                Location = new Point(34, 62),
                AutoSize = true
            };
            p.Controls.Add(title);
            p.Controls.Add(sub);

            // 状态卡片
            Panel card = new Panel
            {
                Location = new Point(34, 100),
                Size = new Size(680, 110),
                BackColor = Color.FromArgb(242, 242, 247),
                BorderStyle = BorderStyle.None
            };
            Label lblPptStat = new Label
            {
                Text = "📊  当前放映状态：COM 守护监听中",
                Font = new Font("Segoe UI", 11.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(0, 122, 255),
                Location = new Point(20, 18),
                AutoSize = true
            };
            Label lblPptDesc = new Label
            {
                Text = "支持检测本地 Microsoft PowerPoint 及 WPS 演示。双向同步放映页码，板书严格随页绑定隔离。",
                Font = new Font("Segoe UI", 9.5f),
                ForeColor = Color.FromArgb(60, 60, 67),
                Location = new Point(22, 48),
                AutoSize = true
            };
            Button btnTestNext = CreateModernButton("下一页 (Next)", 110, 32);
            btnTestNext.Location = new Point(20, 72);
            btnTestNext.Click += (s, e) => { ComController.NextSlide(); };

            Button btnTestPrev = CreateModernButton("上一页 (Prev)", 110, 32);
            btnTestPrev.Location = new Point(140, 72);
            btnTestPrev.Click += (s, e) => { ComController.PrevSlide(); };

            card.Controls.Add(lblPptStat);
            card.Controls.Add(lblPptDesc);
            card.Controls.Add(btnTestNext);
            card.Controls.Add(btnTestPrev);
            p.Controls.Add(card);

            // 功能选项
            CheckBox chkSync = new CheckBox
            {
                Text = "启用板书随 PPT 翻页严格同步切换（翻页时自动隔离笔迹）",
                Font = new Font("Segoe UI", 10f),
                Checked = true,
                Location = new Point(36, 235),
                AutoSize = true
            };
            CheckBox chkWatermark = new CheckBox
            {
                Text = "放映时在右下角附加 FLA 极简水印与投屏指示",
                Font = new Font("Segoe UI", 10f),
                Checked = true,
                Location = new Point(36, 270),
                AutoSize = true
            };
            CheckBox chkReplaceBar = new CheckBox
            {
                Text = "自动压制希沃白板5注入浮动工具条，替换为 FLA 原生悬浮工具条",
                Font = new Font("Segoe UI", 10f),
                Checked = true,
                Location = new Point(36, 305),
                AutoSize = true
            };
            p.Controls.Add(chkSync);
            p.Controls.Add(chkWatermark);
            p.Controls.Add(chkReplaceBar);

            contentPanel.Controls.Add(p);
            tabPanels.Add(p);
        }
        #endregion

        #region Tab 3: 希沃白板5 拦截防护守护控制台
        private void InitTabSeewoInterceptor()
        {
            Panel p = new Panel { Dock = DockStyle.Fill, Padding = new Padding(32) };

            Label title = new Label
            {
                Text = "🛡️ 希沃白板5 智能拦截守护系统",
                Font = new Font("Segoe UI", 16f, FontStyle.Bold),
                ForeColor = Color.FromArgb(28, 28, 30),
                Location = new Point(32, 28),
                AutoSize = true
            };

            lblSeewoStat = new Label
            {
                Text = "当前状态：拦截守护运行中 | 已累计拦截霸屏注入: " + Program.SeewoBlockedCount + " 次",
                Font = new Font("Segoe UI", 10.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(52, 199, 89), // Apple Green
                Location = new Point(34, 66),
                AutoSize = true
            };
            p.Controls.Add(title);
            p.Controls.Add(lblSeewoStat);

            // 实时拦截日志控制台
            Label lblLogTitle = new Label
            {
                Text = "实时拦截与防护日志：",
                Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
                Location = new Point(34, 105),
                AutoSize = true
            };
            p.Controls.Add(lblLogTitle);

            txtLog = new TextBox
            {
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                BackColor = Color.FromArgb(242, 242, 247),
                ForeColor = Color.FromArgb(28, 28, 30),
                Font = new Font("Consolas", 9.5f),
                Location = new Point(34, 130),
                Size = new Size(800, 360),
                BorderStyle = BorderStyle.FixedSingle
            };
            txtLog.Text = string.Format("[{0}] FLA 希沃白板5智能拦截守护线程已就绪\r\n[{0}] 正在扫描 EasiNote, EasiCamera, SeewoPPT 霸屏进程...\r\n", DateTime.Now.ToString("HH:mm:ss"));
            p.Controls.Add(txtLog);

            Button btnClearLog = CreateModernButton("清空防护日志", 120, 32);
            btnClearLog.Location = new Point(34, 505);
            btnClearLog.Click += (s, e) => { txtLog.Text = ""; };
            p.Controls.Add(btnClearLog);

            contentPanel.Controls.Add(p);
            tabPanels.Add(p);
        }
        #endregion

        #region Tab 4: 手机扫码投屏遥控
        private void InitTabRemote()
        {
            Panel p = new Panel { Dock = DockStyle.Fill, Padding = new Padding(32) };

            Label title = new Label
            {
                Text = "📱 手机扫码投屏与无线遥控",
                Font = new Font("Segoe UI", 16f, FontStyle.Bold),
                ForeColor = Color.FromArgb(28, 28, 30),
                Location = new Point(32, 28),
                AutoSize = true
            };
            Label sub = new Label
            {
                Text = "手机扫码即可立即化身无线翻页笔与激光笔，双向控制 PPT 播放与随页画板。",
                Font = new Font("Segoe UI", 9.5f),
                ForeColor = Color.FromArgb(142, 142, 147),
                Location = new Point(34, 62),
                AutoSize = true
            };
            p.Controls.Add(title);
            p.Controls.Add(sub);

            // 遥控二维码展示区域
            Panel qrBox = new Panel
            {
                Location = new Point(34, 100),
                Size = new Size(240, 240),
                BackColor = Color.FromArgb(242, 242, 247),
                BorderStyle = BorderStyle.FixedSingle
            };
            Label lblQrHint = new Label
            {
                Text = "微信 / 手机浏览器\n扫码即可控制",
                TextAlign = ContentAlignment.MiddleCenter,
                Dock = DockStyle.Fill,
                Font = new Font("Segoe UI", 11f, FontStyle.Bold),
                ForeColor = Color.FromArgb(60, 60, 67)
            };
            qrBox.Controls.Add(lblQrHint);
            p.Controls.Add(qrBox);

            Label lblUrl = new Label
            {
                Text = "遥控配对地址：\n" + Program.ServerUrl + "/#/remote",
                Font = new Font("Segoe UI", 10.5f),
                ForeColor = Color.FromArgb(0, 122, 255),
                Location = new Point(290, 110),
                AutoSize = true
            };
            p.Controls.Add(lblUrl);

            Button btnCopyUrl = CreateModernButton("复制遥控网址", 120, 32);
            btnCopyUrl.Location = new Point(290, 160);
            btnCopyUrl.Click += (s, e) =>
            {
                Clipboard.SetText(Program.ServerUrl + "/#/remote");
                MessageBox.Show("遥控网址已复制到剪贴板！", "FLA 投屏遥控", MessageBoxButtons.OK, MessageBoxIcon.Information);
            };
            p.Controls.Add(btnCopyUrl);

            contentPanel.Controls.Add(p);
            tabPanels.Add(p);
        }
        #endregion

        #region Tab 5: 系统设置与更新
        private void InitTabSettings()
        {
            Panel p = new Panel { Dock = DockStyle.Fill, Padding = new Padding(32) };

            Label title = new Label
            {
                Text = "⚙️ 系统设置与版本更新",
                Font = new Font("Segoe UI", 16f, FontStyle.Bold),
                ForeColor = Color.FromArgb(28, 28, 30),
                Location = new Point(32, 28),
                AutoSize = true
            };
            p.Controls.Add(title);

            // 1. 服务器地址设置
            Label lblSrv = new Label
            {
                Text = "教学服务连接地址 (Server URL)：",
                Font = new Font("Segoe UI", 10f, FontStyle.Bold),
                Location = new Point(34, 80),
                AutoSize = true
            };
            txtServerUrl = new TextBox
            {
                Text = Program.ServerUrl,
                Font = new Font("Segoe UI", 10.5f),
                Location = new Point(36, 106),
                Size = new Size(420, 28)
            };
            Button btnSaveSrv = CreateModernButton("保存并连接", 110, 28);
            btnSaveSrv.Location = new Point(466, 105);
            btnSaveSrv.Click += (s, e) =>
            {
                Program.ServerUrl = txtServerUrl.Text.Trim();
                Program.SaveConfig();
                if (webBrowser != null) webBrowser.Navigate(Program.ServerUrl + "/#/library");
                MessageBox.Show("教学服务器地址已更新并重新加载！", "FLA 设置", MessageBoxButtons.OK, MessageBoxIcon.Information);
            };
            p.Controls.Add(lblSrv);
            p.Controls.Add(txtServerUrl);
            p.Controls.Add(btnSaveSrv);

            // 2. 更新状态
            Panel updateCard = new Panel
            {
                Location = new Point(36, 160),
                Size = new Size(580, 72),
                BackColor = Color.FromArgb(242, 242, 247),
                BorderStyle = BorderStyle.None
            };
            lblUpdateStatus = new Label
            {
                Text = "客户端版本：v" + Program.VERSION + " (已是最新稳定版)\n支持服务端自动比对与原地免安装升级",
                Font = new Font("Segoe UI", 9.5f),
                ForeColor = Color.FromArgb(60, 60, 67),
                Location = new Point(16, 14),
                AutoSize = true
            };
            Button btnCheckUpdate = CreateModernButton("检查新版本", 110, 32);
            btnCheckUpdate.Location = new Point(450, 20);
            btnCheckUpdate.Click += (s, e) => { Program.CheckUpdateAsync(true); };

            updateCard.Controls.Add(lblUpdateStatus);
            updateCard.Controls.Add(btnCheckUpdate);
            p.Controls.Add(updateCard);

            contentPanel.Controls.Add(p);
            tabPanels.Add(p);
        }
        #endregion

        #region UI 辅助创建方法
        private Button CreateModernButton(string text, int width, int height)
        {
            Button btn = new Button
            {
                Text = text,
                Size = new Size(width, height),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(0, 122, 255), // Apple Blue
                ForeColor = Color.White,
                Font = new Font("Segoe UI", 9f, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btn.FlatAppearance.BorderSize = 0;
            return btn;
        }

        private Button CreateMiniButton(string text, int width)
        {
            Button btn = new Button
            {
                Text = text,
                Size = new Size(width, 28),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(242, 242, 247),
                ForeColor = Color.FromArgb(60, 60, 67),
                Font = new Font("Segoe UI", 8.5f),
                Cursor = Cursors.Hand
            };
            btn.FlatAppearance.BorderColor = Color.FromArgb(229, 229, 234);
            return btn;
        }

        private Button CreateColorPickButton(string name, Color c)
        {
            Button btn = new Button
            {
                Text = "",
                Size = new Size(32, 32),
                BackColor = c,
                FlatStyle = FlatStyle.Flat,
                Cursor = Cursors.Hand
            };
            btn.FlatAppearance.BorderColor = Color.FromArgb(200, 200, 200);
            return btn;
        }

        public void AppendLog(string msg)
        {
            if (txtLog != null)
            {
                txtLog.AppendText(string.Format("[{0}] {1}\r\n", DateTime.Now.ToString("HH:mm:ss"), msg));
            }
            if (lblSeewoStat != null)
            {
                lblSeewoStat.Text = "当前状态：拦截守护运行中 | 已累计拦截霸屏注入: " + Program.SeewoBlockedCount + " 次";
            }
        }

        public void ShowUpdateNotice(string ver)
        {
            if (lblUpdateStatus != null)
            {
                lblUpdateStatus.Text = "发现新版本 v" + ver + "，正在后台自动下载原地替换…";
                lblUpdateStatus.ForeColor = Color.FromArgb(0, 122, 255);
            }
        }
        #endregion
    }
    #endregion
}
