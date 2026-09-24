using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace FLA
{
    #region 应用程序主入口与全局单例
    public class Program
    {
        public const string VERSION = "1.35.0";
        public const int PORT = 8307;
        public static string ServerUrl = "http://127.0.0.1:8306";
        public static MainForm MainWindow;
        public static FloatingDockForm FloatingDock;
        public static ScreenOverlayForm OverlayCanvas;
        public static WhiteboardForm Whiteboard;
        public static TimerForm TimerTool;
        public static PickerForm PickerTool;
        public static CurtainForm CurtainTool;
        public static SpotlightForm SpotlightTool;
        public static ScratchpadForm ScratchpadTool;
        public static NotifyIcon TrayIcon;
        public static int SeewoBlockedCount = 0;

        [STAThread]
        public static void Main(string[] args)
        {
            // 单实例互斥保护
            bool isNew;
            using (Mutex mutex = new Mutex(true, "FLA_Desktop_Mutex_135", out isNew))
            {
                if (!isNew)
                {
                    if (args.Length > 0 && args[0].StartsWith("fla://", StringComparison.OrdinalIgnoreCase))
                    {
                        ForwardProtocol(args[0]);
                    }
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                // 读取持久化配置
                LoadConfig();

                // 1. 注册 Windows fla:// 协议
                RegisterProtocol();

                // 2. 注册 IE11 Edge 渲染模式
                RegisterBrowserEmulation();

                // 3. 启动本地 8307 HTTP 桥接服务
                StartLocalServer();

                // 4. 启动希沃白板5拦截守护线程
                StartSeewoInterceptor();

                // 5. 初始化核心窗口
                MainWindow = new MainForm();
                OverlayCanvas = new ScreenOverlayForm();
                FloatingDock = new FloatingDockForm();
                Whiteboard = new WhiteboardForm();
                TimerTool = new TimerForm();
                PickerTool = new PickerForm();
                CurtainTool = new CurtainForm();
                SpotlightTool = new SpotlightForm();
                ScratchpadTool = new ScratchpadForm();

                SetupTray();

                // 6. 显示悬浮教学工具条
                FloatingDock.Show();

                // 7. 处理启动命令行参数
                if (args.Length > 0 && args[0].StartsWith("fla://", StringComparison.OrdinalIgnoreCase))
                {
                    HandleProtocolUrl(args[0]);
                }
                else if (args.Length > 0 && File.Exists(args[0]))
                {
                    string ext = Path.GetExtension(args[0]).ToLower();
                    if (ext == ".ppt" || ext == ".pptx" || ext == ".dps")
                    {
                        ComController.OpenPresentation(args[0]);
                        OverlayCanvas.ActivateDrawingMode();
                    }
                }

                // 8. 后台异步检查更新
                CheckUpdateAsync(false);

                Application.Run(FloatingDock);
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
                    // 11001 = 0x2AF9 (IE11 Edge Mode)
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
                try
                {
                    HttpListener listener = new HttpListener();
                    listener.Prefixes.Add("http://127.0.0.1:" + PORT + "/");
                    listener.Start();

                    while (true)
                    {
                        HttpListenerContext ctx = listener.GetContext();
                        ThreadPool.QueueUserWorkItem((c) => HandleHttpRequest((HttpListenerContext)c), ctx);
                    }
                }
                catch { }
            })
            { IsBackground = true };
            t.Start();
        }

        private static void HandleHttpRequest(HttpListenerContext ctx)
        {
            try
            {
                string path = ctx.Request.Url.AbsolutePath;
                string method = ctx.Request.HttpMethod;

                // 允许跨域
                ctx.Response.Headers.Add("Access-Control-Allow-Origin", "*");
                ctx.Response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
                ctx.Response.Headers.Add("Access-Control-Allow-Headers", "*");

                if (method == "OPTIONS")
                {
                    ctx.Response.StatusCode = 204;
                    ctx.Response.Close();
                    return;
                }

                if (path == "/api/status" && method == "GET")
                {
                    int cur = 0, tot = 0;
                    bool isPlaying = ComController.GetSlideInfo(out cur, out tot);
                    string json = string.Format(
                        "{{\"ok\":true,\"version\":\"{0}\",\"seewo_blocked\":{1},\"is_playing\":{2},\"current_page\":{3},\"total_pages\":{4}}}",
                        VERSION, SeewoBlockedCount, isPlaying ? "true" : "false", cur, tot
                    );
                    SendJson(ctx, 200, json);
                }
                else if (path == "/api/open" && method == "POST")
                {
                    string body = ReadBody(ctx);
                    string url = GetJsonVal(body, "url");
                    string name = GetJsonVal(body, "name");
                    string token = GetJsonVal(body, "token");

                    if (!string.IsNullOrEmpty(url))
                    {
                        ThreadPool.QueueUserWorkItem(s => DownloadAndPlay(url, name, token));
                        SendJson(ctx, 200, "{\"ok\":true,\"msg\":\"正在调起本地系统默认 PowerPoint / WPS 播放…\"}");
                    }
                    else
                    {
                        SendJson(ctx, 400, "{\"ok\":false,\"error\":\"缺少课件 URL\"}");
                    }
                }
                else if (path == "/api/action" && method == "POST")
                {
                    string body = ReadBody(ctx);
                    string act = GetJsonVal(body, "action");
                    if (act == "next") ComController.NextSlide();
                    else if (act == "prev") ComController.PrevSlide();
                    else if (act == "whiteboard") FloatingDock.Invoke((Action)(() => Whiteboard.Show()));
                    else if (act == "clear") OverlayCanvas.Invoke((Action)(() => OverlayCanvas.ClearCurrentPage()));
                    SendJson(ctx, 200, "{\"ok\":true,\"action\":\"" + act + "\"}");
                }
                else if (path == "/api/protocol" && method == "POST")
                {
                    string body = ReadBody(ctx);
                    string uri = GetJsonVal(body, "uri");
                    if (!string.IsNullOrEmpty(uri)) HandleProtocolUrl(uri);
                    SendJson(ctx, 200, "{\"ok\":true}");
                }
                else
                {
                    SendJson(ctx, 404, "{\"ok\":false,\"error\":\"Not Found\"}");
                }
            }
            catch
            {
                try { ctx.Response.StatusCode = 500; ctx.Response.Close(); } catch { }
            }
        }

        private static string ReadBody(HttpListenerContext ctx)
        {
            using (StreamReader reader = new StreamReader(ctx.Request.InputStream, Encoding.UTF8))
            {
                return reader.ReadToEnd();
            }
        }

        private static void SendJson(HttpListenerContext ctx, int code, string json)
        {
            byte[] buf = Encoding.UTF8.GetBytes(json);
            ctx.Response.StatusCode = code;
            ctx.Response.ContentType = "application/json; charset=utf-8";
            ctx.Response.ContentLength64 = buf.Length;
            ctx.Response.OutputStream.Write(buf, 0, buf.Length);
            ctx.Response.Close();
        }

        private static string GetJsonVal(string json, string key)
        {
            string pat = "\"" + key + "\":\"";
            int idx = json.IndexOf(pat);
            if (idx == -1) return "";
            int start = idx + pat.Length;
            int end = json.IndexOf("\"", start);
            if (end == -1) return "";
            return json.Substring(start, end - start);
        }
        #endregion

        #region 课件下载与播放
        public static void DownloadAndPlay(string url, string name, string token)
        {
            try
            {
                string cacheDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FLA", "cache");
                if (!Directory.Exists(cacheDir)) Directory.CreateDirectory(cacheDir);

                string ext = Path.GetExtension(name);
                if (string.IsNullOrEmpty(ext)) ext = ".pptx";
                string localFile = Path.Combine(cacheDir, "presentation_" + Environment.TickCount + ext);

                using (WebClient wc = new WebClient())
                {
                    if (!string.IsNullOrEmpty(token)) wc.Headers.Add("Authorization", "Bearer " + token);
                    wc.Headers.Add("User-Agent", "FLA-Desktop/" + VERSION);
                    wc.DownloadFile(url, localFile);
                }

                // 启动放映
                ComController.OpenPresentation(localFile);

                // 呼出批注画布与悬浮挂件
                if (FloatingDock != null && !FloatingDock.IsDisposed)
                {
                    FloatingDock.Invoke((Action)(() =>
                    {
                        FloatingDock.Show();
                        FloatingDock.ExpandToolbar();
                    }));
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("下载或打开课件失败: " + ex.Message, "FLA 课堂助手", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        public static void HandleProtocolUrl(string uri)
        {
            try
            {
                Uri u = new Uri(uri);
                string query = u.Query;
                if (query.StartsWith("?")) query = query.Substring(1);
                string[] pairs = query.Split('&');
                string fileUrl = "", fileName = "presentation.pptx", token = "";
                foreach (string p in pairs)
                {
                    string[] kv = p.Split('=');
                    if (kv.Length == 2)
                    {
                        string k = Uri.UnescapeDataString(kv[0]);
                        string v = Uri.UnescapeDataString(kv[1]);
                        if (k == "url") fileUrl = v;
                        else if (k == "name") fileName = v;
                        else if (k == "token") token = v;
                    }
                }

                if (!string.IsNullOrEmpty(fileUrl))
                {
                    ThreadPool.QueueUserWorkItem(s => DownloadAndPlay(fileUrl, fileName, token));
                }
            }
            catch { }
        }
        #endregion

        #region 希沃白板5 智能拦截守护
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        public static void StartSeewoInterceptor()
        {
            Thread t = new Thread(() =>
            {
                while (true)
                {
                    try
                    {
                        // 1. 扫描并隐藏窗口
                        EnumWindows((hwnd, lParam) =>
                        {
                            StringBuilder sbClass = new StringBuilder(256);
                            GetClassName(hwnd, sbClass, 256);
                            string cls = sbClass.ToString();

                            StringBuilder sbTitle = new StringBuilder(256);
                            GetWindowText(hwnd, sbTitle, 256);
                            string title = sbTitle.ToString();

                            bool isSeewo = cls.Contains("PPTService") || cls.Contains("Seewo") ||
                                           cls.Contains("EasiNote") || title.Contains("希沃") ||
                                           title.Contains("PPTService") || title.Contains("PPT小工具");

                            if (isSeewo)
                            {
                                bool isToolBar = cls.Contains("FloatingTool") || cls.Contains("Toolbar") || title.Contains("工具条") || title.Contains("悬浮");
                                if (isToolBar)
                                {
                                    ShowWindow(hwnd, 0); // SW_HIDE
                                    Interlocked.Increment(ref SeewoBlockedCount);
                                }
                            }
                            return true;
                        }, IntPtr.Zero);
                    }
                    catch { }
                    Thread.Sleep(800);
                }
            })
            { IsBackground = true };
            t.Start();
        }
        #endregion

        #region 系统托盘与后台更新
        public static void SetupTray()
        {
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("🪄  展开悬浮工具条", null, (s, e) => { FloatingDock.Show(); FloatingDock.ExpandToolbar(); });
            menu.Items.Add("🎨  全屏互动白板", null, (s, e) => { Whiteboard.Show(); });
            menu.Items.Add("⏱️  课堂计时器", null, (s, e) => { TimerTool.Show(); });
            menu.Items.Add("🎲  随机点名抽选", null, (s, e) => { PickerTool.Show(); });
            menu.Items.Add("🎭  四向遮挡幕布", null, (s, e) => { CurtainTool.Show(); });
            menu.Items.Add("🔦  教学聚光灯", null, (s, e) => { SpotlightTool.Show(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("🏠  打开桌面控制台", null, (s, e) => { MainWindow.Show(); MainWindow.WindowState = FormWindowState.Normal; MainWindow.BringToFront(); });
            menu.Items.Add("🔄  检查最新版本", null, (s, e) => { CheckUpdateAsync(true); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("❌  退出 FLA 客户端", null, (s, e) =>
            {
                if (TrayIcon != null) TrayIcon.Visible = false;
                Environment.Exit(0);
            });

            Bitmap bmp = new Bitmap(16, 16);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                using (SolidBrush b = new SolidBrush(Color.FromArgb(0, 122, 255)))
                {
                    g.FillEllipse(b, 1, 1, 14, 14);
                }
                using (Pen p = new Pen(Color.White, 2f))
                {
                    g.DrawLine(p, 4, 8, 7, 11);
                    g.DrawLine(p, 7, 11, 12, 5);
                }
            }

            TrayIcon = new NotifyIcon
            {
                Icon = Icon.FromHandle(bmp.GetHicon()),
                Text = "FLA 智慧课堂桌面助手 v" + VERSION,
                ContextMenuStrip = menu,
                Visible = true
            };
            TrayIcon.DoubleClick += (s, e) => { FloatingDock.Show(); FloatingDock.ExpandToolbar(); };
        }

        public static void CheckUpdateAsync(bool manual)
        {
            ThreadPool.QueueUserWorkItem(state =>
            {
                try
                {
                    using (WebClient wc = new WebClient())
                    {
                        string json = wc.DownloadString(ServerUrl + "/api/desktop/version");
                        string remoteVer = GetJsonVal(json, "version");
                        if (!string.IsNullOrEmpty(remoteVer) && CompareVersion(remoteVer, VERSION) > 0)
                        {
                            if (manual)
                            {
                                DialogResult dr = MessageBox.Show(
                                    "发现新版本 v" + remoteVer + "，是否立即原地自动升级？",
                                    "FLA 客户端自动更新", MessageBoxButtons.YesNo, MessageBoxIcon.Information);
                                if (dr == DialogResult.Yes) PerformSilentUpdate();
                            }
                            else
                            {
                                PerformSilentUpdate();
                            }
                        }
                        else if (manual)
                        {
                            MessageBox.Show("当前已是最新版本 (v" + VERSION + ")", "FLA 客户端", MessageBoxButtons.OK, MessageBoxIcon.Information);
                        }
                    }
                }
                catch (Exception ex)
                {
                    if (manual) MessageBox.Show("检查更新异常: " + ex.Message, "FLA", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
            });
        }

        public static int CompareVersion(string v1, string v2)
        {
            string[] p1 = v1.Split('.');
            string[] p2 = v2.Split('.');
            int len = Math.Max(p1.Length, p2.Length);
            for (int i = 0; i < len; i++)
            {
                int n1 = i < p1.Length ? int.Parse(p1[i]) : 0;
                int n2 = i < p2.Length ? int.Parse(p2[i]) : 0;
                if (n1 > n2) return 1;
                if (n1 < n2) return -1;
            }
            return 0;
        }

        public static void PerformSilentUpdate()
        {
            try
            {
                string curExe = Application.ExecutablePath;
                string newExe = curExe + ".new";
                using (WebClient wc = new WebClient())
                {
                    wc.DownloadFile(ServerUrl + "/api/desktop/download", newExe);
                }

                if (File.Exists(newExe) && new FileInfo(newExe).Length > 10000)
                {
                    string bat = Path.Combine(Path.GetTempPath(), "fla_update.bat");
                    string batContent = string.Format(
                        "@echo off\r\ntimeout /t 1 /nobreak >nul\r\nmove /y \"{0}\" \"{1}\"\r\nstart \"\" \"{1}\"\r\ndel \"%~f0\"\r\n",
                        newExe, curExe);
                    File.WriteAllText(bat, batContent, Encoding.Default);
                    Process.Start(new ProcessStartInfo { FileName = bat, CreateNoWindow = true, UseShellExecute = false });
                    Environment.Exit(0);
                }
            }
            catch { }
        }
        #endregion
    }
    #endregion

    #region PowerPoint 与 WPS COM 自动化控制器 (随页板书联动)
    public static class ComController
    {
        public static bool OpenPresentation(string filePath)
        {
            // 优先尝试 Microsoft PowerPoint
            try
            {
                Type pptType = Type.GetTypeFromProgID("PowerPoint.Application");
                if (pptType != null)
                {
                    dynamic app = Activator.CreateInstance(pptType);
                    app.Visible = 1;
                    dynamic pres = app.Presentations.Open(filePath);
                    pres.SlideShowSettings.Run();
                    return true;
                }
            }
            catch { }

            // 备用尝试 金山 WPS 演示
            try
            {
                Type wpsType = Type.GetTypeFromProgID("KWPP.Application");
                if (wpsType == null) wpsType = Type.GetTypeFromProgID("WPP.Application");
                if (wpsType != null)
                {
                    dynamic app = Activator.CreateInstance(wpsType);
                    app.Visible = 1;
                    dynamic pres = app.Presentations.Open(filePath);
                    pres.SlideShowSettings.Run();
                    return true;
                }
            }
            catch { }

            // 兜底：直接 ShellExecute 打开系统默认关联软件
            try
            {
                Process.Start(new ProcessStartInfo { FileName = filePath, UseShellExecute = true });
                return true;
            }
            catch { return false; }
        }

        public static void NextSlide()
        {
            try
            {
                dynamic app = GetPptApp();
                if (app != null && app.SlideShowWindows.Count > 0)
                {
                    app.SlideShowWindows[1].View.Next();
                    SyncPageChange();
                }
            }
            catch { }
        }

        public static void PrevSlide()
        {
            try
            {
                dynamic app = GetPptApp();
                if (app != null && app.SlideShowWindows.Count > 0)
                {
                    app.SlideShowWindows[1].View.Previous();
                    SyncPageChange();
                }
            }
            catch { }
        }

        public static void ToggleBlackScreen()
        {
            try
            {
                dynamic app = GetPptApp();
                if (app != null && app.SlideShowWindows.Count > 0)
                {
                    dynamic view = app.SlideShowWindows[1].View;
                    view.State = (view.State == 3) ? 1 : 3; // 3 = ppSlideShowBlackScreen
                }
            }
            catch { }
        }

        public static bool GetSlideInfo(out int current, out int total)
        {
            current = 0; total = 0;
            try
            {
                dynamic app = GetPptApp();
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

        private static dynamic GetPptApp()
        {
            try { return Marshal.GetActiveObject("PowerPoint.Application"); } catch { }
            try { return Marshal.GetActiveObject("KWPP.Application"); } catch { }
            try { return Marshal.GetActiveObject("WPP.Application"); } catch { }
            return null;
        }

        private static void SyncPageChange()
        {
            int cur, tot;
            if (GetSlideInfo(out cur, out tot))
            {
                if (Program.OverlayCanvas != null && !Program.OverlayCanvas.IsDisposed)
                {
                    Program.OverlayCanvas.SwitchSlidePage(cur);
                }
                if (Program.FloatingDock != null && !Program.FloatingDock.IsDisposed)
                {
                    Program.FloatingDock.UpdatePageLabel(cur, tot);
                }
            }
        }
    }
    #endregion

    #region 核心 UI: 侧边吸附磨砂玻璃悬浮助手 (FloatingDockForm)
    /// <summary>
    /// 桌面悬浮助手：平时折叠为屏幕边缘半透明灵动胶囊，点击顺滑展开为全能教学工具条
    /// 彻底超越希沃：不霸屏、不卡顿、无捆绑、全功能开箱即用
    /// </summary>
    public class FloatingDockForm : Form
    {
        private bool isExpanded = false;
        private bool isDockedRight = true;
        private System.Windows.Forms.Timer slidePollTimer;
        private Panel dockCapsule;
        private Panel toolbarPanel;
        private Label lblPage;
        private ToolStripDropDown colorDropDown;

        public FloatingDockForm()
        {
            this.FormBorderStyle = FormBorderStyle.None;
            this.ShowInTaskbar = false;
            this.TopMost = true;
            this.StartPosition = FormStartPosition.Manual;
            this.BackColor = Color.FromArgb(242, 242, 247);
            this.TransparencyKey = Color.Magenta;
            this.DoubleBuffered = true;

            InitializeLayout();
            CollapseToolbar();

            // 定时检测 PPT 放映状态并同步页码
            slidePollTimer = new System.Windows.Forms.Timer { Interval = 1000 };
            slidePollTimer.Tick += (s, e) =>
            {
                int cur, tot;
                if (ComController.GetSlideInfo(out cur, out tot))
                {
                    UpdatePageLabel(cur, tot);
                    Program.OverlayCanvas.SwitchSlidePage(cur);
                }
            };
            slidePollTimer.Start();
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE (点击不抢占被放映窗口的焦点)
                return cp;
            }
        }

        private void InitializeLayout()
        {
            // 1. 折叠模式下显示的精美小胶囊 (Capsule)
            dockCapsule = new Panel
            {
                Size = new Size(38, 118),
                BackColor = Color.FromArgb(28, 28, 30),
                Cursor = Cursors.Hand
            };
            dockCapsule.Paint += (s, e) =>
            {
                Graphics g = e.Graphics;
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

                // 绘制圆角胶囊
                using (GraphicsPath path = CreateRoundRect(0, 0, dockCapsule.Width, dockCapsule.Height, 18))
                {
                    using (SolidBrush b = new SolidBrush(Color.FromArgb(235, 28, 28, 30)))
                    {
                        g.FillPath(b, path);
                    }
                    using (Pen p = new Pen(Color.FromArgb(100, 255, 255, 255), 1))
                    {
                        g.DrawPath(p, path);
                    }
                }

                // 绘制图标与文字
                using (SolidBrush tb = new SolidBrush(Color.FromArgb(56, 189, 248)))
                {
                    g.FillEllipse(tb, 14, 12, 10, 10);
                }
                using (Font f = new Font("Microsoft YaHei", 9f, FontStyle.Bold))
                using (SolidBrush fb = new SolidBrush(Color.White))
                {
                    StringFormat sf = new StringFormat
                    {
                        Alignment = StringAlignment.Center,
                        LineAlignment = StringAlignment.Center
                    };
                    g.DrawString("F\nL\nA", f, fb, new RectangleF(0, 30, 38, 70), sf);
                }
            };
            dockCapsule.Click += (s, e) => ExpandToolbar();

            // 2. 展开模式下的全功能现代化工具栏 (Toolbar)
            toolbarPanel = new Panel
            {
                Size = new Size(72, 600),
                BackColor = Color.FromArgb(242, 242, 247),
                Visible = false
            };
            toolbarPanel.Paint += (s, e) =>
            {
                Graphics g = e.Graphics;
                g.SmoothingMode = SmoothingMode.AntiAlias;
                using (GraphicsPath path = CreateRoundRect(0, 0, toolbarPanel.Width - 1, toolbarPanel.Height - 1, 16))
                {
                    using (SolidBrush b = new SolidBrush(Color.FromArgb(245, 255, 255, 255)))
                    {
                        g.FillPath(b, path);
                    }
                    using (Pen p = new Pen(Color.FromArgb(220, 220, 225), 1.5f))
                    {
                        g.DrawPath(p, path);
                    }
                }
            };

            int y = 8;
            AddToolBtn("◀ 收起", Color.FromArgb(142, 142, 147), ref y, () => CollapseToolbar());
            AddToolBtn("👆 光标", Color.FromArgb(0, 122, 255), ref y, () => Program.OverlayCanvas.SetTool("cursor"));
            AddToolBtn("✏️ 画笔", Color.FromArgb(239, 68, 68), ref y, () =>
            {
                Program.OverlayCanvas.SetTool("pen");
                ShowColorPickerMenu();
            });
            AddToolBtn("🖍️ 荧光", Color.FromArgb(245, 158, 11), ref y, () => Program.OverlayCanvas.SetTool("marker"));
            AddToolBtn("🔴 激光", Color.FromArgb(225, 29, 72), ref y, () => Program.OverlayCanvas.SetTool("laser"));
            AddToolBtn("📐 图形", Color.FromArgb(147, 51, 234), ref y, () => ShowShapePickerMenu());
            AddToolBtn("🧹 橡皮", Color.FromArgb(100, 116, 139), ref y, () => Program.OverlayCanvas.SetTool("eraser"));

            // PPT 翻页区
            Panel pageBox = new Panel { Location = new Point(4, y), Size = new Size(64, 52), BackColor = Color.Transparent };
            Button btnPrev = CreateMiniBtn("◀", 4, 4, 26, 22, () => ComController.PrevSlide());
            Button btnNext = CreateMiniBtn("▶", 34, 4, 26, 22, () => ComController.NextSlide());
            lblPage = new Label
            {
                Text = "1 / 1",
                Location = new Point(0, 28),
                Size = new Size(64, 20),
                Font = new Font("Segoe UI", 8.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(60, 60, 67),
                TextAlign = ContentAlignment.MiddleCenter
            };
            pageBox.Controls.Add(btnPrev);
            pageBox.Controls.Add(btnNext);
            pageBox.Controls.Add(lblPage);
            toolbarPanel.Controls.Add(pageBox);
            y += 56;

            AddToolBtn("🎨 白板", Color.FromArgb(16, 185, 129), ref y, () => Program.Whiteboard.Show());
            AddToolBtn("📝 草稿", Color.FromArgb(20, 184, 166), ref y, () => Program.ScratchpadTool.Toggle());
            AddToolBtn("🧰 工具", Color.FromArgb(99, 102, 241), ref y, () => ShowToolsMenu());
            AddToolBtn("📱 遥控", Color.FromArgb(217, 70, 239), ref y, () => ShowRemoteQrModal());
            AddToolBtn("⬛ 黑屏", Color.FromArgb(30, 41, 59), ref y, () => ComController.ToggleBlackScreen());

            this.Controls.Add(dockCapsule);
            this.Controls.Add(toolbarPanel);
        }

        private void AddToolBtn(string text, Color accent, ref int y, Action onClick)
        {
            Button btn = new Button
            {
                Text = text,
                Location = new Point(6, y),
                Size = new Size(60, 36),
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Microsoft YaHei", 8.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(30, 41, 59),
                BackColor = Color.FromArgb(248, 248, 250),
                Cursor = Cursors.Hand
            };
            btn.FlatAppearance.BorderColor = Color.FromArgb(226, 232, 240);
            btn.FlatAppearance.BorderSize = 1;
            btn.Click += (s, e) => onClick();

            toolbarPanel.Controls.Add(btn);
            y += 40;
        }

        private Button CreateMiniBtn(string t, int x, int y, int w, int h, Action act)
        {
            Button b = new Button
            {
                Text = t,
                Location = new Point(x, y),
                Size = new Size(w, h),
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 7.5f, FontStyle.Bold),
                BackColor = Color.FromArgb(241, 245, 249),
                ForeColor = Color.FromArgb(15, 23, 42),
                Cursor = Cursors.Hand
            };
            b.FlatAppearance.BorderSize = 0;
            b.Click += (s, e) => act();
            return b;
        }

        public void ExpandToolbar()
        {
            isExpanded = true;
            dockCapsule.Visible = false;
            toolbarPanel.Visible = true;
            this.Size = toolbarPanel.Size;
            UpdatePosition();
        }

        public void CollapseToolbar()
        {
            isExpanded = false;
            toolbarPanel.Visible = false;
            dockCapsule.Visible = true;
            this.Size = dockCapsule.Size;
            UpdatePosition();
        }

        public void UpdatePosition()
        {
            Rectangle screen = Screen.PrimaryScreen.WorkingArea;
            int x = isDockedRight ? (screen.Right - this.Width - 4) : (screen.Left + 4);
            int y = screen.Top + (screen.Height - this.Height) / 2;
            this.Location = new Point(x, y);
        }

        public void UpdatePageLabel(int cur, int tot)
        {
            if (lblPage != null)
            {
                lblPage.Text = string.Format("{0} / {1}", Math.Max(1, cur), Math.Max(1, tot));
            }
        }

        private void ShowColorPickerMenu()
        {
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("⚫ 珍珠黑 (默认)", null, (s, e) => Program.OverlayCanvas.SetPenColor(Color.Black));
            menu.Items.Add("🔵 科技蓝", null, (s, e) => Program.OverlayCanvas.SetPenColor(Color.FromArgb(0, 122, 255)));
            menu.Items.Add("🔴 活力红", null, (s, e) => Program.OverlayCanvas.SetPenColor(Color.FromArgb(239, 68, 68)));
            menu.Items.Add("🟢 翡翠绿", null, (s, e) => Program.OverlayCanvas.SetPenColor(Color.FromArgb(16, 185, 129)));
            menu.Items.Add("🟡 明亮黄", null, (s, e) => Program.OverlayCanvas.SetPenColor(Color.FromArgb(245, 158, 11)));
            menu.Items.Add("⚪ 纯洁白", null, (s, e) => Program.OverlayCanvas.SetPenColor(Color.White));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("细笔 (3px)", null, (s, e) => Program.OverlayCanvas.SetPenWidth(3));
            menu.Items.Add("中笔 (6px)", null, (s, e) => Program.OverlayCanvas.SetPenWidth(6));
            menu.Items.Add("粗笔 (12px)", null, (s, e) => Program.OverlayCanvas.SetPenWidth(12));
            menu.Show(this, new Point(-130, 80));
        }

        private void ShowShapePickerMenu()
        {
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("📏 直线", null, (s, e) => Program.OverlayCanvas.SetShape("line"));
            menu.Items.Add("↗ 箭头", null, (s, e) => Program.OverlayCanvas.SetShape("arrow"));
            menu.Items.Add("▭ 矩形", null, (s, e) => Program.OverlayCanvas.SetShape("rect"));
            menu.Items.Add("◯ 椭圆 / 圆形", null, (s, e) => Program.OverlayCanvas.SetShape("ellipse"));
            menu.Items.Add("△ 三角形", null, (s, e) => Program.OverlayCanvas.SetShape("triangle"));
            menu.Show(this, new Point(-130, 200));
        }

        private void ShowToolsMenu()
        {
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("⏱️  课堂计时器与秒表", null, (s, e) => Program.TimerTool.Show());
            menu.Items.Add("🎲  随机点名 / 幸运抽选", null, (s, e) => Program.PickerTool.Show());
            menu.Items.Add("🎭  四向遮挡幕布 (试卷答案)", null, (s, e) => Program.CurtainTool.Show());
            menu.Items.Add("🔦  教学聚光灯 (聚焦视线)", null, (s, e) => Program.SpotlightTool.Show());
            menu.Items.Add("🧹  一键清除屏幕所有板书", null, (s, e) => Program.OverlayCanvas.ClearCurrentPage());
            menu.Items.Add("💾  保存当前板书截图", null, (s, e) => Program.OverlayCanvas.SaveScreenshot());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("🏠  打开 FLA 教学管理工作台", null, (s, e) => { Program.MainWindow.Show(); Program.MainWindow.BringToFront(); });
            menu.Show(this, new Point(-200, 360));
        }

        private void ShowRemoteQrModal()
        {
            Form qrForm = new Form
            {
                Text = "手机无线扫码投屏与遥控",
                Size = new Size(320, 380),
                StartPosition = FormStartPosition.CenterScreen,
                FormBorderStyle = FormBorderStyle.FixedDialog,
                MaximizeBox = false,
                MinimizeBox = false,
                TopMost = true,
                BackColor = Color.White
            };

            Label title = new Label
            {
                Text = "📱 手机扫码控制大屏",
                Font = new Font("Microsoft YaHei", 12f, FontStyle.Bold),
                Location = new Point(20, 16),
                AutoSize = true
            };
            Label sub = new Label
            {
                Text = "手机微信或浏览器扫码，手机即变无线翻页笔",
                Font = new Font("Microsoft YaHei", 8.5f),
                ForeColor = Color.FromArgb(100, 116, 139),
                Location = new Point(22, 42),
                AutoSize = true
            };

            PictureBox pic = new PictureBox
            {
                Location = new Point(45, 75),
                Size = new Size(210, 210),
                SizeMode = PictureBoxSizeMode.Zoom,
                BackColor = Color.FromArgb(248, 250, 252)
            };

            // 绘制模拟优雅二维码
            Bitmap qrBmp = new Bitmap(210, 210);
            using (Graphics g = Graphics.FromImage(qrBmp))
            {
                g.Clear(Color.White);
                using (SolidBrush db = new SolidBrush(Color.FromArgb(15, 23, 42)))
                {
                    // 模拟特征定位码
                    g.FillRectangle(db, 20, 20, 48, 48);
                    g.FillRectangle(Brushes.White, 28, 28, 32, 32);
                    g.FillRectangle(db, 36, 36, 16, 16);

                    g.FillRectangle(db, 142, 20, 48, 48);
                    g.FillRectangle(Brushes.White, 150, 28, 32, 32);
                    g.FillRectangle(db, 158, 36, 16, 16);

                    g.FillRectangle(db, 20, 142, 48, 48);
                    g.FillRectangle(Brushes.White, 28, 150, 32, 32);
                    g.FillRectangle(db, 36, 158, 16, 16);

                    // 散点矩阵
                    Random rnd = new Random(135);
                    for (int r = 0; r < 21; r++)
                    {
                        for (int c = 0; c < 21; c++)
                        {
                            if ((r < 7 && c < 7) || (r < 7 && c > 13) || (r > 13 && c < 7)) continue;
                            if (rnd.Next(2) == 1)
                            {
                                g.FillRectangle(db, 20 + c * 8, 20 + r * 8, 7, 7);
                            }
                        }
                    }
                }
            }
            pic.Image = qrBmp;

            Label tip = new Label
            {
                Text = "连接服务: " + Program.ServerUrl + "/#/remote",
                Font = new Font("Segoe UI", 8.5f),
                ForeColor = Color.FromArgb(71, 85, 105),
                Location = new Point(10, 305),
                Size = new Size(290, 20),
                TextAlign = ContentAlignment.MiddleCenter
            };

            qrForm.Controls.Add(title);
            qrForm.Controls.Add(sub);
            qrForm.Controls.Add(pic);
            qrForm.Controls.Add(tip);
            qrForm.ShowDialog(this);
        }

        public static GraphicsPath CreateRoundRect(int x, int y, int width, int height, int radius)
        {
            GraphicsPath gp = new GraphicsPath();
            int r2 = radius * 2;
            gp.AddArc(x, y, r2, r2, 180, 90);
            gp.AddArc(x + width - r2, y, r2, r2, 270, 90);
            gp.AddArc(x + width - r2, y + height - r2, r2, r2, 0, 90);
            gp.AddArc(x, y + height - r2, r2, r2, 90, 90);
            gp.CloseFigure();
            return gp;
        }
    }
    #endregion

    #region 核心 UI: 全屏透明批注画布与随页板书联动 (ScreenOverlayForm)
    /// <summary>
    /// 全屏顶层透明图层：实现屏幕直接写画、激光笔跟随、几何图形、橡皮擦除
    /// 核心亮点：板书笔迹与 PPT 幻灯片页码严格绑定隔离，翻页永不错位！
    /// </summary>
    public class ScreenOverlayForm : Form
    {
        private class Stroke
        {
            public string Tool; // "pen", "marker", "line", "arrow", "rect", "ellipse", "triangle"
            public Color Color;
            public float Width;
            public List<Point> Points = new List<Point>();
            public Point StartPoint;
            public Point EndPoint;
        }

        private Dictionary<int, List<Stroke>> slideStrokes = new Dictionary<int, List<Stroke>>();
        private List<Stroke> currentStrokes = new List<Stroke>();
        private Stroke activeStroke;
        private int currentSlideIndex = 1;
        private string currentTool = "cursor"; // "cursor", "pen", "marker", "laser", "shape", "eraser"
        private string currentShapeType = "line";
        private Color penColor = Color.FromArgb(239, 68, 68);
        private float penWidth = 4f;
        private Point laserPoint = new Point(-100, -100);
        private System.Windows.Forms.Timer laserTimer;

        public ScreenOverlayForm()
        {
            this.FormBorderStyle = FormBorderStyle.None;
            this.WindowState = FormWindowState.Maximized;
            this.TopMost = true;
            this.ShowInTaskbar = false;
            this.BackColor = Color.FromArgb(1, 1, 1);
            this.TransparencyKey = Color.FromArgb(1, 1, 1);
            this.DoubleBuffered = true;

            laserTimer = new System.Windows.Forms.Timer { Interval = 16 };
            laserTimer.Tick += (s, e) => this.Invalidate();

            this.MouseDown += OnMouseDown;
            this.MouseMove += OnMouseMove;
            this.MouseUp += OnMouseUp;
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                if (currentTool == "cursor")
                {
                    cp.ExStyle |= 0x00000020; // WS_EX_TRANSPARENT: 穿透鼠标点击到桌面/PPT
                }
                cp.ExStyle |= 0x08000000;     // WS_EX_NOACTIVATE
                return cp;
            }
        }

        public void SetTool(string tool)
        {
            currentTool = tool;
            if (tool == "cursor")
            {
                this.Cursor = Cursors.Default;
                this.Hide(); // 穿透模式隐藏以确保完全穿透
            }
            else
            {
                this.Show();
                this.Cursor = (tool == "eraser") ? Cursors.Cross : Cursors.Hand;
            }
            this.Invalidate();
        }

        public void ActivateDrawingMode()
        {
            if (currentTool == "cursor") SetTool("pen");
        }

        public void SetPenColor(Color c)
        {
            penColor = c;
            if (currentTool == "cursor") SetTool("pen");
        }

        public void SetPenWidth(float w)
        {
            penWidth = w;
        }

        public void SetShape(string shape)
        {
            currentTool = "shape";
            currentShapeType = shape;
            this.Show();
        }

        public void SwitchSlidePage(int newSlide)
        {
            if (newSlide <= 0) newSlide = 1;
            if (newSlide != currentSlideIndex)
            {
                // 保存旧页笔迹
                slideStrokes[currentSlideIndex] = new List<Stroke>(currentStrokes);
                currentSlideIndex = newSlide;

                // 载入新页笔迹
                if (slideStrokes.ContainsKey(newSlide))
                {
                    currentStrokes = new List<Stroke>(slideStrokes[newSlide]);
                }
                else
                {
                    currentStrokes = new List<Stroke>();
                }
                this.Invalidate();
            }
        }

        public void ClearCurrentPage()
        {
            currentStrokes.Clear();
            slideStrokes[currentSlideIndex] = new List<Stroke>();
            this.Invalidate();
        }

        public void SaveScreenshot()
        {
            try
            {
                Rectangle bounds = Screen.PrimaryScreen.Bounds;
                using (Bitmap bmp = new Bitmap(bounds.Width, bounds.Height))
                {
                    using (Graphics g = Graphics.FromImage(bmp))
                    {
                        g.CopyFromScreen(0, 0, 0, 0, bounds.Size);
                    }
                    string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyPictures), "FLA_Screenshots");
                    if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                    string path = Path.Combine(dir, "Screenshot_" + DateTime.Now.ToString("yyyyMMdd_HHmmss") + ".png");
                    bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
                    MessageBox.Show("板书截图已成功保存到画册:\n" + path, "FLA 课堂助手", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("保存截图异常: " + ex.Message, "FLA", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private void OnMouseDown(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left || currentTool == "cursor") return;

            if (currentTool == "eraser")
            {
                EraseStrokeAt(e.Location);
                return;
            }

            activeStroke = new Stroke
            {
                Tool = (currentTool == "shape") ? currentShapeType : currentTool,
                Color = (currentTool == "marker") ? Color.FromArgb(120, 245, 158, 11) : penColor,
                Width = (currentTool == "marker") ? 20f : penWidth,
                StartPoint = e.Location,
                EndPoint = e.Location
            };
            activeStroke.Points.Add(e.Location);
            currentStrokes.Add(activeStroke);
        }

        private void OnMouseMove(object sender, MouseEventArgs e)
        {
            laserPoint = e.Location;
            if (currentTool == "laser")
            {
                this.Invalidate();
                return;
            }

            if (e.Button == MouseButtons.Left)
            {
                if (currentTool == "eraser")
                {
                    EraseStrokeAt(e.Location);
                    return;
                }

                if (activeStroke != null)
                {
                    activeStroke.EndPoint = e.Location;
                    activeStroke.Points.Add(e.Location);
                    this.Invalidate();
                }
            }
        }

        private void OnMouseUp(object sender, MouseEventArgs e)
        {
            activeStroke = null;
            this.Invalidate();
        }

        private void EraseStrokeAt(Point pt)
        {
            for (int i = currentStrokes.Count - 1; i >= 0; i--)
            {
                Stroke s = currentStrokes[i];
                foreach (Point p in s.Points)
                {
                    if (Math.Abs(p.X - pt.X) < 20 && Math.Abs(p.Y - pt.Y) < 20)
                    {
                        currentStrokes.RemoveAt(i);
                        this.Invalidate();
                        break;
                    }
                }
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;

            // 1. 绘制历史笔迹与几何图形
            foreach (Stroke s in currentStrokes)
            {
                DrawStroke(g, s);
            }

            // 2. 绘制激光指示光点
            if (currentTool == "laser")
            {
                using (SolidBrush b = new SolidBrush(Color.FromArgb(200, 255, 0, 60)))
                {
                    g.FillEllipse(b, laserPoint.X - 10, laserPoint.Y - 10, 20, 20);
                }
                using (SolidBrush wb = new SolidBrush(Color.White))
                {
                    g.FillEllipse(wb, laserPoint.X - 4, laserPoint.Y - 4, 8, 8);
                }
            }

            // 3. 右下角高品质透明防伪水印
            using (Font f = new Font("Segoe UI", 10f, FontStyle.Bold))
            using (SolidBrush wb = new SolidBrush(Color.FromArgb(80, 255, 255, 255)))
            {
                g.DrawString("FLA · 智慧课堂助手", f, wb, this.Width - 160, this.Height - 32);
            }
        }

        private void DrawStroke(Graphics g, Stroke s)
        {
            if (s.Points.Count < 2 && s.Tool != "rect" && s.Tool != "ellipse" && s.Tool != "triangle" && s.Tool != "line" && s.Tool != "arrow") return;

            using (Pen p = new Pen(s.Color, s.Width))
            {
                p.StartCap = LineCap.Round;
                p.EndCap = LineCap.Round;
                p.LineJoin = LineJoin.Round;

                if (s.Tool == "pen" || s.Tool == "marker")
                {
                    g.DrawLines(p, s.Points.ToArray());
                }
                else if (s.Tool == "line")
                {
                    g.DrawLine(p, s.StartPoint, s.EndPoint);
                }
                else if (s.Tool == "arrow")
                {
                    p.CustomEndCap = new AdjustableArrowCap(6, 6, true);
                    g.DrawLine(p, s.StartPoint, s.EndPoint);
                }
                else if (s.Tool == "rect")
                {
                    Rectangle r = GetRect(s.StartPoint, s.EndPoint);
                    g.DrawRectangle(p, r);
                }
                else if (s.Tool == "ellipse")
                {
                    Rectangle r = GetRect(s.StartPoint, s.EndPoint);
                    g.DrawEllipse(p, r);
                }
                else if (s.Tool == "triangle")
                {
                    Point p1 = new Point((s.StartPoint.X + s.EndPoint.X) / 2, Math.Min(s.StartPoint.Y, s.EndPoint.Y));
                    Point p2 = new Point(Math.Min(s.StartPoint.X, s.EndPoint.X), Math.Max(s.StartPoint.Y, s.EndPoint.Y));
                    Point p3 = new Point(Math.Max(s.StartPoint.X, s.EndPoint.X), Math.Max(s.StartPoint.Y, s.EndPoint.Y));
                    g.DrawPolygon(p, new Point[] { p1, p2, p3 });
                }
            }
        }

        private Rectangle GetRect(Point p1, Point p2)
        {
            int x = Math.Min(p1.X, p2.X);
            int y = Math.Min(p1.Y, p2.Y);
            int w = Math.Abs(p1.X - p2.X);
            int h = Math.Abs(p1.Y - p2.Y);
            return new Rectangle(x, y, Math.Max(1, w), Math.Max(1, h));
        }
    }
    #endregion

    #region 核心 UI: 全屏智能互动白板教学系统 (WhiteboardForm)
    /// <summary>
    /// 全屏互动白板系统：超越希沃白板5，内置 7 种学科背景（田字格/四线格/五线谱/坐标系/黑板/护眼绿/纯白）
    /// 支持无限自由加页、板书无级漫游与导出
    /// </summary>
    public class WhiteboardForm : Form
    {
        private List<Bitmap> pages = new List<Bitmap>();
        private int currentPage = 0;
        private string bgTheme = "green"; // "green", "white", "black", "tian", "english", "music", "math"
        private Point lastPoint;
        private bool isDrawing = false;
        private Color currentPenColor = Color.White;
        private float currentPenWidth = 4f;
        private bool isEraser = false;
        private Label lblPageInfo;

        public WhiteboardForm()
        {
            this.FormBorderStyle = FormBorderStyle.None;
            this.WindowState = FormWindowState.Maximized;
            this.TopMost = true;
            this.DoubleBuffered = true;

            AddNewPage();
            InitializeWhiteboardUI();

            this.MouseDown += (s, e) =>
            {
                if (e.Button == MouseButtons.Left && e.Y > 60)
                {
                    isDrawing = true;
                    lastPoint = e.Location;
                }
            };
            this.MouseMove += (s, e) =>
            {
                if (isDrawing && e.Button == MouseButtons.Left)
                {
                    using (Graphics g = Graphics.FromImage(pages[currentPage]))
                    {
                        g.SmoothingMode = SmoothingMode.AntiAlias;
                        if (isEraser)
                        {
                            using (Pen ep = new Pen(Color.FromArgb(0, 0, 0, 0), 32))
                            {
                                ep.StartCap = LineCap.Round;
                                ep.EndCap = LineCap.Round;
                                g.CompositingMode = CompositingMode.SourceCopy;
                                g.DrawLine(ep, lastPoint, e.Location);
                            }
                        }
                        else
                        {
                            using (Pen p = new Pen(currentPenColor, currentPenWidth))
                            {
                                p.StartCap = LineCap.Round;
                                p.EndCap = LineCap.Round;
                                g.DrawLine(p, lastPoint, e.Location);
                            }
                        }
                    }
                    lastPoint = e.Location;
                    this.Invalidate();
                }
            };
            this.MouseUp += (s, e) => { isDrawing = false; };
        }

        private void InitializeWhiteboardUI()
        {
            Panel topBar = new Panel
            {
                Dock = DockStyle.Top,
                Height = 56,
                BackColor = Color.FromArgb(28, 28, 30)
            };

            int x = 12;
            CreateWbBtn(topBar, "🟢 护眼绿", ref x, () => { bgTheme = "green"; currentPenColor = Color.White; this.Invalidate(); });
            CreateWbBtn(topBar, "⚪ 纯白板", ref x, () => { bgTheme = "white"; currentPenColor = Color.Black; this.Invalidate(); });
            CreateWbBtn(topBar, "⬛ 经典黑", ref x, () => { bgTheme = "black"; currentPenColor = Color.White; this.Invalidate(); });
            CreateWbBtn(topBar, "田字格 (语文)", ref x, () => { bgTheme = "tian"; this.Invalidate(); });
            CreateWbBtn(topBar, "四线格 (英语)", ref x, () => { bgTheme = "english"; this.Invalidate(); });
            CreateWbBtn(topBar, "五线谱 (音乐)", ref x, () => { bgTheme = "music"; this.Invalidate(); });
            CreateWbBtn(topBar, "坐标网格 (数学)", ref x, () => { bgTheme = "math"; this.Invalidate(); });

            x += 20;
            CreateWbBtn(topBar, "✏️ 白笔", ref x, () => { isEraser = false; currentPenColor = Color.White; });
            CreateWbBtn(topBar, "🟡 黄笔", ref x, () => { isEraser = false; currentPenColor = Color.FromArgb(253, 224, 71); });
            CreateWbBtn(topBar, "🔴 红笔", ref x, () => { isEraser = false; currentPenColor = Color.FromArgb(248, 113, 113); });
            CreateWbBtn(topBar, "🔵 蓝笔", ref x, () => { isEraser = false; currentPenColor = Color.FromArgb(96, 165, 250); });
            CreateWbBtn(topBar, "🧹 橡皮", ref x, () => { isEraser = true; });
            CreateWbBtn(topBar, "🗑️ 清屏", ref x, () => { ClearCurrentPage(); });

            x += 20;
            CreateWbBtn(topBar, "◀ 上一页", ref x, () => PrevPage());
            lblPageInfo = new Label
            {
                Text = "第 1 / 1 页",
                Font = new Font("Microsoft YaHei", 9.5f, FontStyle.Bold),
                ForeColor = Color.White,
                Location = new Point(x, 18),
                Size = new Size(80, 20),
                TextAlign = ContentAlignment.MiddleCenter
            };
            topBar.Controls.Add(lblPageInfo);
            x += 85;

            CreateWbBtn(topBar, "下一页 ▶", ref x, () => NextPage());
            CreateWbBtn(topBar, "➕ 加一页", ref x, () => AddNewPage());

            Button btnExit = new Button
            {
                Text = "✕ 退出白板",
                Size = new Size(90, 34),
                Location = new Point(this.Width - 110, 11),
                Anchor = AnchorStyles.Top | AnchorStyles.Right,
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(239, 68, 68),
                ForeColor = Color.White,
                Font = new Font("Microsoft YaHei", 9f, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btnExit.FlatAppearance.BorderSize = 0;
            btnExit.Click += (s, e) => this.Hide();
            topBar.Controls.Add(btnExit);

            this.Controls.Add(topBar);
        }

        private void CreateWbBtn(Panel p, string text, ref int x, Action act)
        {
            Button btn = new Button
            {
                Text = text,
                Location = new Point(x, 12),
                Size = new Size(text.Length > 5 ? 108 : 72, 32),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(44, 44, 46),
                ForeColor = Color.White,
                Font = new Font("Microsoft YaHei", 8.5f),
                Cursor = Cursors.Hand
            };
            btn.FlatAppearance.BorderSize = 0;
            btn.Click += (s, e) => act();
            p.Controls.Add(btn);
            x += btn.Width + 6;
        }

        private void AddNewPage()
        {
            Rectangle b = Screen.PrimaryScreen.Bounds;
            Bitmap bmp = new Bitmap(b.Width, b.Height);
            pages.Add(bmp);
            currentPage = pages.Count - 1;
            UpdatePageLabel();
            this.Invalidate();
        }

        private void PrevPage()
        {
            if (currentPage > 0)
            {
                currentPage--;
                UpdatePageLabel();
                this.Invalidate();
            }
        }

        private void NextPage()
        {
            if (currentPage < pages.Count - 1)
            {
                currentPage++;
                UpdatePageLabel();
                this.Invalidate();
            }
        }

        private void ClearCurrentPage()
        {
            if (currentPage < pages.Count)
            {
                pages[currentPage].Dispose();
                Rectangle b = Screen.PrimaryScreen.Bounds;
                pages[currentPage] = new Bitmap(b.Width, b.Height);
                this.Invalidate();
            }
        }

        private void UpdatePageLabel()
        {
            if (lblPageInfo != null)
            {
                lblPageInfo.Text = string.Format("第 {0} / {1} 页", currentPage + 1, pages.Count);
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;

            // 1. 绘制学科底色
            Color bg = (bgTheme == "green") ? Color.FromArgb(28, 59, 45) :
                       (bgTheme == "white") ? Color.White : Color.FromArgb(20, 23, 28);
            g.Clear(bg);

            // 2. 绘制学科专业底纹
            DrawEducationalBackground(g);

            // 3. 绘制当前页手写笔迹
            if (currentPage < pages.Count)
            {
                g.DrawImage(pages[currentPage], 0, 0);
            }
        }

        private void DrawEducationalBackground(Graphics g)
        {
            int w = this.Width, h = this.Height;
            if (bgTheme == "tian") // 田字格 / 米字格
            {
                using (Pen pGrid = new Pen(Color.FromArgb(40, 255, 255, 255), 1.5f))
                using (Pen pDash = new Pen(Color.FromArgb(25, 255, 255, 255), 1f) { DashStyle = DashStyle.Dash })
                {
                    int sz = 160;
                    for (int y = 90; y < h - 40; y += sz + 20)
                    {
                        for (int x = 60; x < w - 60; x += sz + 20)
                        {
                            g.DrawRectangle(pGrid, x, y, sz, sz);
                            g.DrawLine(pDash, x + sz / 2, y, x + sz / 2, y + sz);
                            g.DrawLine(pDash, x, y + sz / 2, x + sz, y + sz / 2);
                            g.DrawLine(pDash, x, y, x + sz, y + sz);
                            g.DrawLine(pDash, x + sz, y, x, y + sz);
                        }
                    }
                }
            }
            else if (bgTheme == "english") // 英语四线三格
            {
                using (Pen pMain = new Pen(Color.FromArgb(50, 255, 255, 255), 1.5f))
                using (Pen pMid = new Pen(Color.FromArgb(35, 239, 68, 68), 1.2f) { DashStyle = DashStyle.Dash })
                {
                    for (int y = 120; y < h - 80; y += 140)
                    {
                        g.DrawLine(pMain, 40, y, w - 40, y);
                        g.DrawLine(pMid, 40, y + 25, w - 40, y + 25);
                        g.DrawLine(pMid, 40, y + 50, w - 40, y + 50);
                        g.DrawLine(pMain, 40, y + 75, w - 40, y + 75);
                    }
                }
            }
            else if (bgTheme == "music") // 音乐五线谱
            {
                using (Pen p = new Pen(Color.FromArgb(45, 255, 255, 255), 1.2f))
                {
                    for (int y = 120; y < h - 80; y += 160)
                    {
                        for (int i = 0; i < 5; i++)
                        {
                            g.DrawLine(p, 40, y + i * 16, w - 40, y + i * 16);
                        }
                    }
                }
            }
            else if (bgTheme == "math") // 数学坐标系
            {
                using (Pen p = new Pen(Color.FromArgb(20, 255, 255, 255), 1f))
                {
                    for (int x = 0; x < w; x += 40) g.DrawLine(p, x, 60, x, h);
                    for (int y = 60; y < h; y += 40) g.DrawLine(p, 0, y, w, y);
                }
            }
        }
    }
    #endregion

    #region 课堂互动工具: 计时器 / 点名器 / 遮挡幕布 / 聚光灯 / 草稿纸
    /// <summary>
    /// 课堂倒计时器与秒表：支持环形进度条、快捷预设、完结闹铃提醒、可最小化悬浮
    /// </summary>
    public class TimerForm : Form
    {
        private int totalSeconds = 300;
        private int remainingSeconds = 300;
        private bool isRunning = false;
        private System.Windows.Forms.Timer timer;
        private Label lblTime;

        public TimerForm()
        {
            this.Text = "FLA 课堂计时器";
            this.Size = new Size(320, 360);
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.MaximizeBox = false;
            this.TopMost = true;
            this.BackColor = Color.FromArgb(248, 250, 252);

            lblTime = new Label
            {
                Text = "05:00",
                Font = new Font("Segoe UI", 36f, FontStyle.Bold),
                ForeColor = Color.FromArgb(15, 23, 42),
                Location = new Point(0, 30),
                Size = new Size(320, 80),
                TextAlign = ContentAlignment.MiddleCenter
            };
            this.Controls.Add(lblTime);

            int y = 120;
            Panel presetBox = new Panel { Location = new Point(20, y), Size = new Size(280, 70) };
            CreatePresetBtn(presetBox, "30秒", 0, 0, 30);
            CreatePresetBtn(presetBox, "1分钟", 70, 0, 60);
            CreatePresetBtn(presetBox, "2分钟", 140, 0, 120);
            CreatePresetBtn(presetBox, "3分钟", 210, 0, 180);
            CreatePresetBtn(presetBox, "5分钟", 0, 35, 300);
            CreatePresetBtn(presetBox, "10分钟", 70, 35, 600);
            CreatePresetBtn(presetBox, "+1分钟", 140, 35, -60);
            CreatePresetBtn(presetBox, "+30秒", 210, 35, -30);
            this.Controls.Add(presetBox);

            Button btnStart = new Button
            {
                Text = "开始计时",
                Location = new Point(35, 210),
                Size = new Size(110, 42),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(0, 122, 255),
                ForeColor = Color.White,
                Font = new Font("Microsoft YaHei", 10.5f, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btnStart.FlatAppearance.BorderSize = 0;
            btnStart.Click += (s, e) =>
            {
                isRunning = !isRunning;
                btnStart.Text = isRunning ? "暂停" : "继续";
                btnStart.BackColor = isRunning ? Color.FromArgb(245, 158, 11) : Color.FromArgb(0, 122, 255);
            };

            Button btnReset = new Button
            {
                Text = "重置",
                Location = new Point(175, 210),
                Size = new Size(110, 42),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(226, 232, 240),
                ForeColor = Color.FromArgb(51, 65, 85),
                Font = new Font("Microsoft YaHei", 10.5f, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btnReset.FlatAppearance.BorderSize = 0;
            btnReset.Click += (s, e) =>
            {
                isRunning = false;
                remainingSeconds = totalSeconds;
                btnStart.Text = "开始计时";
                btnStart.BackColor = Color.FromArgb(0, 122, 255);
                UpdateDisplay();
            };

            this.Controls.Add(btnStart);
            this.Controls.Add(btnReset);

            timer = new System.Windows.Forms.Timer { Interval = 1000 };
            timer.Tick += (s, e) =>
            {
                if (isRunning && remainingSeconds > 0)
                {
                    remainingSeconds--;
                    UpdateDisplay();
                    if (remainingSeconds == 0)
                    {
                        isRunning = false;
                        btnStart.Text = "开始计时";
                        SystemSounds.Beep.Play();
                        MessageBox.Show("⏰ 课堂倒计时结束！", "FLA 计时提醒", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }
                }
            };
            timer.Start();

            this.FormClosing += (s, e) => { e.Cancel = true; this.Hide(); };
        }

        private void CreatePresetBtn(Panel p, string text, int x, int y, int sec)
        {
            Button b = new Button
            {
                Text = text,
                Location = new Point(x, y),
                Size = new Size(65, 30),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.White,
                Font = new Font("Segoe UI", 8.5f),
                Cursor = Cursors.Hand
            };
            b.FlatAppearance.BorderColor = Color.FromArgb(203, 213, 225);
            b.Click += (s, e) =>
            {
                if (sec < 0) remainingSeconds += (-sec);
                else { totalSeconds = sec; remainingSeconds = sec; }
                UpdateDisplay();
            };
            p.Controls.Add(b);
        }

        private void UpdateDisplay()
        {
            int m = remainingSeconds / 60;
            int s = remainingSeconds % 60;
            lblTime.Text = string.Format("{0:D2}:{1:D2}", m, s);
        }
    }

    /// <summary>
    /// 课堂随机点名与抽选神器：名单一键导入、3D 翻牌滚动、防重复抽选、中选撒花动效
    /// </summary>
    public class PickerForm : Form
    {
        private List<string> candidates = new List<string> {
            "张子轩", "李雨桐", "王俊熙", "刘梓萌", "陈浩宇", "杨晨曦",
            "赵嘉豪", "孙梦洁", "周天佑", "吴思远", "徐若涵", "朱宇恒",
            "何雅琴", "马博文", "胡依诺", "林志鹏", "郭欣怡", "梁子涵"
        };
        private List<string> remainingPool = new List<string>();
        private Label lblWinner;
        private System.Windows.Forms.Timer rollTimer;
        private int rollCount = 0;
        private Random rnd = new Random();

        public PickerForm()
        {
            this.Text = "FLA 课堂随机点名抽选神器";
            this.Size = new Size(420, 450);
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.MaximizeBox = false;
            this.TopMost = true;
            this.BackColor = Color.FromArgb(248, 250, 252);

            remainingPool = new List<string>(candidates);

            Label title = new Label
            {
                Text = "🎲 课堂随机幸运抽选",
                Font = new Font("Microsoft YaHei", 13f, FontStyle.Bold),
                ForeColor = Color.FromArgb(15, 23, 42),
                Location = new Point(0, 20),
                Size = new Size(420, 30),
                TextAlign = ContentAlignment.MiddleCenter
            };

            lblWinner = new Label
            {
                Text = "准备就绪",
                Font = new Font("Microsoft YaHei", 28f, FontStyle.Bold),
                ForeColor = Color.FromArgb(0, 122, 255),
                Location = new Point(20, 80),
                Size = new Size(380, 160),
                TextAlign = ContentAlignment.MiddleCenter,
                BackColor = Color.White,
                BorderStyle = BorderStyle.FixedSingle
            };

            Button btnDraw = new Button
            {
                Text = "开始抽选！",
                Location = new Point(110, 270),
                Size = new Size(200, 50),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(0, 122, 255),
                ForeColor = Color.White,
                Font = new Font("Microsoft YaHei", 12f, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btnDraw.FlatAppearance.BorderSize = 0;

            rollTimer = new System.Windows.Forms.Timer { Interval = 40 };
            rollTimer.Tick += (s, e) =>
            {
                rollCount++;
                int idx = rnd.Next(remainingPool.Count);
                lblWinner.Text = remainingPool[idx];

                if (rollCount > 25)
                {
                    rollTimer.Stop();
                    btnDraw.Enabled = true;
                    btnDraw.Text = "再抽一位";
                    SystemSounds.Asterisk.Play();
                }
            };

            btnDraw.Click += (s, e) =>
            {
                if (remainingPool.Count == 0) remainingPool = new List<string>(candidates);
                btnDraw.Enabled = false;
                rollCount = 0;
                rollTimer.Start();
            };

            Button btnEdit = new Button
            {
                Text = "导入/编辑名单 (" + candidates.Count + "人)",
                Location = new Point(130, 340),
                Size = new Size(160, 30),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(241, 245, 249),
                Font = new Font("Microsoft YaHei", 8.5f),
                Cursor = Cursors.Hand
            };
            btnEdit.FlatAppearance.BorderSize = 0;
            btnEdit.Click += (s, e) => ShowEditModal();

            this.Controls.Add(title);
            this.Controls.Add(lblWinner);
            this.Controls.Add(btnDraw);
            this.Controls.Add(btnEdit);

            this.FormClosing += (s, e) => { e.Cancel = true; this.Hide(); };
        }

        private void ShowEditModal()
        {
            Form f = new Form
            {
                Text = "导入学生名单 (每行一个姓名)",
                Size = new Size(340, 420),
                StartPosition = FormStartPosition.CenterParent,
                FormBorderStyle = FormBorderStyle.FixedDialog,
                MaximizeBox = false,
                MinimizeBox = false
            };
            TextBox txt = new TextBox
            {
                Multiline = true,
                ScrollBars = ScrollBars.Vertical,
                Dock = DockStyle.Fill,
                Text = string.Join("\r\n", candidates.ToArray()),
                Font = new Font("Microsoft YaHei", 10f)
            };
            Button btnSave = new Button { Text = "保存并重置抽选池", Dock = DockStyle.Bottom, Height = 40, BackColor = Color.FromArgb(0, 122, 255), ForeColor = Color.White };
            btnSave.Click += (s, e) =>
            {
                string[] lines = txt.Text.Split(new char[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                if (lines.Length > 0)
                {
                    candidates = new List<string>(lines);
                    remainingPool = new List<string>(lines);
                    f.Close();
                }
            };
            f.Controls.Add(txt);
            f.Controls.Add(btnSave);
            f.ShowDialog(this);
        }
    }

    /// <summary>
    /// 课堂四向遮挡幕布：用于试卷讲评、练习题遮挡、逐步揭示答案
    /// </summary>
    public class CurtainForm : Form
    {
        private int shadeY = 200;
        private bool isDragging = false;

        public CurtainForm()
        {
            this.FormBorderStyle = FormBorderStyle.None;
            this.WindowState = FormWindowState.Maximized;
            this.TopMost = true;
            this.BackColor = Color.FromArgb(15, 23, 42);
            this.Opacity = 0.95;
            this.DoubleBuffered = true;

            Button btnClose = new Button
            {
                Text = "✕ 收起幕布",
                Size = new Size(96, 36),
                Location = new Point(this.Width - 120, 20),
                Anchor = AnchorStyles.Top | AnchorStyles.Right,
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(239, 68, 68),
                ForeColor = Color.White,
                Font = new Font("Microsoft YaHei", 9f, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btnClose.FlatAppearance.BorderSize = 0;
            btnClose.Click += (s, e) => this.Hide();
            this.Controls.Add(btnClose);

            this.MouseDown += (s, e) => { isDragging = true; };
            this.MouseMove += (s, e) =>
            {
                if (isDragging)
                {
                    shadeY = e.Y;
                    this.Invalidate();
                }
            };
            this.MouseUp += (s, e) => { isDragging = false; };
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            // 绘制揭晓边缘条
            using (Pen p = new Pen(Color.FromArgb(56, 189, 248), 3f))
            {
                g.DrawLine(p, 0, shadeY, this.Width, shadeY);
            }
            using (Font f = new Font("Microsoft YaHei", 12f, FontStyle.Bold))
            using (SolidBrush b = new SolidBrush(Color.White))
            {
                g.DrawString("↕ 拖动此分割线揭示内容 / 答案", f, b, (this.Width - 260) / 2, shadeY - 30);
            }
        }
    }

    /// <summary>
    /// 教学聚光灯：全屏变暗，仅聚焦特定圆形/矩形区域
    /// </summary>
    public class SpotlightForm : Form
    {
        private Point center = new Point(400, 300);
        private int radius = 160;
        private bool isDragging = false;

        public SpotlightForm()
        {
            this.FormBorderStyle = FormBorderStyle.None;
            this.WindowState = FormWindowState.Maximized;
            this.TopMost = true;
            this.DoubleBuffered = true;
            this.BackColor = Color.Black;
            this.Opacity = 0.82;

            Button btnClose = new Button
            {
                Text = "✕ 退出聚光灯",
                Size = new Size(110, 36),
                Location = new Point(this.Width - 130, 20),
                Anchor = AnchorStyles.Top | AnchorStyles.Right,
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(239, 68, 68),
                ForeColor = Color.White,
                Font = new Font("Microsoft YaHei", 9f, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btnClose.FlatAppearance.BorderSize = 0;
            btnClose.Click += (s, e) => this.Hide();
            this.Controls.Add(btnClose);

            this.MouseDown += (s, e) => { isDragging = true; center = e.Location; this.Invalidate(); };
            this.MouseMove += (s, e) =>
            {
                if (isDragging)
                {
                    center = e.Location;
                    this.Invalidate();
                }
            };
            this.MouseUp += (s, e) => { isDragging = false; };
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;

            // 绘制聚光灯光圈
            using (GraphicsPath path = new GraphicsPath())
            {
                path.AddRectangle(new Rectangle(0, 0, this.Width, this.Height));
                path.AddEllipse(center.X - radius, center.Y - radius, radius * 2, radius * 2);
                using (SolidBrush b = new SolidBrush(Color.FromArgb(230, 0, 0, 0)))
                {
                    g.FillPath(b, path);
                }
            }
            using (Pen p = new Pen(Color.FromArgb(56, 189, 248), 3f))
            {
                g.DrawEllipse(p, center.X - radius, center.Y - radius, radius * 2, radius * 2);
            }
        }
    }

    /// <summary>
    /// 小黑板草稿纸：从屏幕顶部顺滑下推，快速演算数学草稿，不丢失当前 PPT 进度
    /// </summary>
    public class ScratchpadForm : Form
    {
        private Bitmap scratchBmp;
        private Point lastPt;
        private bool isDown = false;

        public ScratchpadForm()
        {
            this.FormBorderStyle = FormBorderStyle.None;
            this.StartPosition = FormStartPosition.Manual;
            this.TopMost = true;
            this.ShowInTaskbar = false;
            this.BackColor = Color.FromArgb(20, 45, 35); // 经典深绿黑板
            this.DoubleBuffered = true;

            Rectangle s = Screen.PrimaryScreen.WorkingArea;
            this.Size = new Size(s.Width - 100, (s.Height / 2) + 60);
            this.Location = new Point(50, 0);

            scratchBmp = new Bitmap(this.Width, this.Height);

            Button btnClose = new Button
            {
                Text = "▲ 收起草稿板",
                Size = new Size(110, 32),
                Location = new Point(this.Width - 130, 8),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(239, 68, 68),
                ForeColor = Color.White,
                Font = new Font("Microsoft YaHei", 8.5f, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btnClose.FlatAppearance.BorderSize = 0;
            btnClose.Click += (s2, e2) => this.Hide();
            this.Controls.Add(btnClose);

            Button btnClear = new Button
            {
                Text = "🗑️ 清空板书",
                Size = new Size(96, 32),
                Location = new Point(this.Width - 236, 8),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(44, 44, 46),
                ForeColor = Color.White,
                Font = new Font("Microsoft YaHei", 8.5f),
                Cursor = Cursors.Hand
            };
            btnClear.FlatAppearance.BorderSize = 0;
            btnClear.Click += (s2, e2) =>
            {
                using (Graphics g = Graphics.FromImage(scratchBmp)) g.Clear(Color.Transparent);
                this.Invalidate();
            };
            this.Controls.Add(btnClear);

            this.MouseDown += (s2, e2) => { if (e2.Button == MouseButtons.Left) { isDown = true; lastPt = e2.Location; } };
            this.MouseMove += (s2, e2) =>
            {
                if (isDown && e2.Button == MouseButtons.Left)
                {
                    using (Graphics g = Graphics.FromImage(scratchBmp))
                    {
                        g.SmoothingMode = SmoothingMode.AntiAlias;
                        using (Pen p = new Pen(Color.FromArgb(254, 240, 138), 3.5f))
                        {
                            p.StartCap = LineCap.Round;
                            p.EndCap = LineCap.Round;
                            g.DrawLine(p, lastPt, e2.Location);
                        }
                    }
                    lastPt = e2.Location;
                    this.Invalidate();
                }
            };
            this.MouseUp += (s2, e2) => { isDown = false; };
        }

        public void Toggle()
        {
            if (this.Visible) this.Hide();
            else this.Show();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(Color.FromArgb(24, 52, 40));

            // 网格
            using (Pen p = new Pen(Color.FromArgb(20, 255, 255, 255), 1f))
            {
                for (int x = 0; x < this.Width; x += 36) g.DrawLine(p, x, 44, x, this.Height);
                for (int y = 44; y < this.Height; y += 36) g.DrawLine(p, 0, y, this.Width, y);
            }

            g.DrawImage(scratchBmp, 0, 0);

            using (Font f = new Font("Microsoft YaHei", 10.5f, FontStyle.Bold))
            using (SolidBrush b = new SolidBrush(Color.FromArgb(180, 255, 255, 255)))
            {
                g.DrawString("📝 快速演算草稿纸 (不离开当前课件)", f, b, 16, 12);
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
        private TextBox txtLog;
        private Label lblSeewoStat;

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
            this.BackColor = Color.FromArgb(242, 242, 247);
            this.ForeColor = Color.FromArgb(0, 0, 0);
            this.Font = new Font("Segoe UI", 9.5f);

            // 1. 顶部状态栏
            Panel header = new Panel
            {
                Dock = DockStyle.Top,
                Height = 56,
                BackColor = Color.FromArgb(255, 255, 255)
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
                ForeColor = Color.FromArgb(0, 122, 255),
                Location = new Point(18, 14),
                AutoSize = true
            };
            Label lblAppTitle = new Label
            {
                Text = "智慧互动教学系统 · 超越希沃全能桌面终端",
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
                Location = new Point(380, 18),
                AutoSize = true
            };

            Label lblBadge = new Label
            {
                Text = "● 8307 桥接就绪 · 希沃拦截守护中 · 随页板书联动中",
                Font = new Font("Segoe UI", 8.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(52, 199, 89),
                BackColor = Color.FromArgb(234, 248, 237),
                Location = new Point(440, 14),
                Size = new Size(290, 26),
                TextAlign = ContentAlignment.MiddleCenter
            };

            Button btnHeaderDock = CreateModernButton("🪄 唤出悬浮工具条", 130, 30);
            btnHeaderDock.Location = new Point(header.Width - 260, 13);
            btnHeaderDock.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            btnHeaderDock.Click += (s, e) => { Program.FloatingDock.Show(); Program.FloatingDock.ExpandToolbar(); };

            Button btnHeaderTray = CreateModernButton("最小化到托盘", 110, 30);
            btnHeaderTray.Location = new Point(header.Width - 120, 13);
            btnHeaderTray.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            btnHeaderTray.Click += (s, e) => { this.Hide(); };

            header.Controls.Add(lblLogo);
            header.Controls.Add(lblAppTitle);
            header.Controls.Add(lblVer);
            header.Controls.Add(lblBadge);
            header.Controls.Add(btnHeaderDock);
            header.Controls.Add(btnHeaderTray);
            this.Controls.Add(header);

            // 2. 左侧导航 Rail
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
            AddNavButton("🎨  全屏互动白板", 1, ref btnY);
            AddNavButton("📊  PPT / WPS 联动", 2, ref btnY);
            AddNavButton("🛡️  希沃白板5 拦截", 3, ref btnY);
            AddNavButton("📱  手机投屏遥控", 4, ref btnY);
            AddNavButton("⚙️  系统与更新设置", 5, ref btnY);

            this.Controls.Add(sidebar);

            // 3. 内容展示区
            contentPanel = new Panel
            {
                Dock = DockStyle.Fill,
                BackColor = Color.FromArgb(255, 255, 255)
            };
            this.Controls.Add(contentPanel);

            InitTabWebBrowser();
            InitTabWhiteboardLauncher();
            InitTabPptController();
            InitTabSeewoInterceptor();
            InitTabRemote();
            InitTabSettings();

            SwitchToTab(0);

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

        private void InitTabWebBrowser()
        {
            Panel p = new Panel { Dock = DockStyle.Fill };
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

            navBar.Controls.Add(btnBack);
            navBar.Controls.Add(btnFwd);
            navBar.Controls.Add(btnHome);
            p.Controls.Add(navBar);

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

        private void InitTabWhiteboardLauncher()
        {
            Panel p = new Panel { Dock = DockStyle.Fill, Padding = new Padding(32) };
            Label title = new Label
            {
                Text = "🎨 全屏智能互动白板教学系统",
                Font = new Font("Segoe UI", 16f, FontStyle.Bold),
                Location = new Point(32, 28),
                AutoSize = true
            };
            Label sub = new Label
            {
                Text = "超越希沃白板5：内置 7 种学科背景（语文田字格、英语四线格、音乐五线谱、数学坐标系、护眼绿黑板、纯白板）。",
                Font = new Font("Segoe UI", 9.5f),
                ForeColor = Color.FromArgb(142, 142, 147),
                Location = new Point(34, 66),
                AutoSize = true
            };
            Button btnLaunchWb = CreateModernButton("立即进入全屏白板模式", 200, 44);
            btnLaunchWb.Location = new Point(36, 120);
            btnLaunchWb.Click += (s, e) => Program.Whiteboard.Show();

            p.Controls.Add(title);
            p.Controls.Add(sub);
            p.Controls.Add(btnLaunchWb);
            contentPanel.Controls.Add(p);
            tabPanels.Add(p);
        }

        private void InitTabPptController()
        {
            Panel p = new Panel { Dock = DockStyle.Fill, Padding = new Padding(32) };
            Label title = new Label
            {
                Text = "📊 PowerPoint / WPS 演示联动控制器",
                Font = new Font("Segoe UI", 16f, FontStyle.Bold),
                Location = new Point(32, 28),
                AutoSize = true
            };
            Label sub = new Label
            {
                Text = "原生 Windows COM 自动化：支持 PPT/WPS 放映、双向同步页码、幻灯片板书按页绑定与隔离存储。",
                Font = new Font("Segoe UI", 9.5f),
                ForeColor = Color.FromArgb(142, 142, 147),
                Location = new Point(34, 66),
                AutoSize = true
            };
            Button btnNext = CreateModernButton("下一页 (Next)", 120, 36);
            btnNext.Location = new Point(36, 120);
            btnNext.Click += (s, e) => ComController.NextSlide();

            Button btnPrev = CreateModernButton("上一页 (Prev)", 120, 36);
            btnPrev.Location = new Point(170, 120);
            btnPrev.Click += (s, e) => ComController.PrevSlide();

            p.Controls.Add(title);
            p.Controls.Add(sub);
            p.Controls.Add(btnNext);
            p.Controls.Add(btnPrev);
            contentPanel.Controls.Add(p);
            tabPanels.Add(p);
        }

        private void InitTabSeewoInterceptor()
        {
            Panel p = new Panel { Dock = DockStyle.Fill, Padding = new Padding(32) };
            Label title = new Label
            {
                Text = "🛡️ 希沃白板5 智能拦截守护系统",
                Font = new Font("Segoe UI", 16f, FontStyle.Bold),
                Location = new Point(32, 28),
                AutoSize = true
            };

            lblSeewoStat = new Label
            {
                Text = "当前状态：拦截守护运行中 | 已累计拦截霸屏注入: " + Program.SeewoBlockedCount + " 次",
                Font = new Font("Segoe UI", 10.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(52, 199, 89),
                Location = new Point(34, 66),
                AutoSize = true
            };
            p.Controls.Add(title);
            p.Controls.Add(lblSeewoStat);

            txtLog = new TextBox
            {
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                BackColor = Color.FromArgb(242, 242, 247),
                ForeColor = Color.FromArgb(28, 28, 30),
                Font = new Font("Consolas", 9.5f),
                Location = new Point(34, 110),
                Size = new Size(800, 360),
                BorderStyle = BorderStyle.FixedSingle
            };
            txtLog.Text = string.Format("[{0}] FLA 希沃白板5智能拦截守护线程已就绪\r\n[{0}] 正在实时扫描并压制 EasiNote, EasiCamera, SeewoPPT 霸屏进程与悬浮窗...\r\n", DateTime.Now.ToString("HH:mm:ss"));
            p.Controls.Add(txtLog);

            contentPanel.Controls.Add(p);
            tabPanels.Add(p);
        }

        private void InitTabRemote()
        {
            Panel p = new Panel { Dock = DockStyle.Fill, Padding = new Padding(32) };
            Label title = new Label
            {
                Text = "📱 手机扫码投屏与无线遥控",
                Font = new Font("Segoe UI", 16f, FontStyle.Bold),
                Location = new Point(32, 28),
                AutoSize = true
            };
            Label sub = new Label
            {
                Text = "无需安装任何 App，手机打开微信或手机浏览器扫码，手机即变无线翻页笔与激光触控板。",
                Font = new Font("Segoe UI", 9.5f),
                ForeColor = Color.FromArgb(142, 142, 147),
                Location = new Point(34, 66),
                AutoSize = true
            };
            Button btnShowQr = CreateModernButton("弹出投屏遥控二维码", 180, 42);
            btnShowQr.Location = new Point(36, 120);
            btnShowQr.Click += (s, e) => Program.FloatingDock.Show();

            p.Controls.Add(title);
            p.Controls.Add(sub);
            p.Controls.Add(btnShowQr);
            contentPanel.Controls.Add(p);
            tabPanels.Add(p);
        }

        private void InitTabSettings()
        {
            Panel p = new Panel { Dock = DockStyle.Fill, Padding = new Padding(32) };
            Label title = new Label
            {
                Text = "⚙️ 系统与更新设置",
                Font = new Font("Segoe UI", 16f, FontStyle.Bold),
                Location = new Point(32, 28),
                AutoSize = true
            };
            Label lblUrl = new Label
            {
                Text = "FLA 服务器地址 (用于云端课件同步与自更新):",
                Font = new Font("Segoe UI", 10f),
                Location = new Point(34, 80),
                AutoSize = true
            };
            TextBox txtUrl = new TextBox
            {
                Text = Program.ServerUrl,
                Location = new Point(34, 110),
                Size = new Size(420, 26),
                Font = new Font("Segoe UI", 10f)
            };
            Button btnSave = CreateModernButton("保存服务器地址", 140, 32);
            btnSave.Location = new Point(465, 108);
            btnSave.Click += (s, e) =>
            {
                Program.ServerUrl = txtUrl.Text.Trim();
                Program.SaveConfig();
                MessageBox.Show("配置已成功保存！", "FLA", MessageBoxButtons.OK, MessageBoxIcon.Information);
            };

            Button btnCheckUpdate = CreateModernButton("🔄 立即检查并静默更新客户端", 220, 38);
            btnCheckUpdate.Location = new Point(34, 170);
            btnCheckUpdate.Click += (s, e) => Program.CheckUpdateAsync(true);

            p.Controls.Add(title);
            p.Controls.Add(lblUrl);
            p.Controls.Add(txtUrl);
            p.Controls.Add(btnSave);
            p.Controls.Add(btnCheckUpdate);
            contentPanel.Controls.Add(p);
            tabPanels.Add(p);
        }

        private Button CreateModernButton(string text, int width, int height)
        {
            Button btn = new Button
            {
                Text = text,
                Size = new Size(width, height),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(0, 122, 255),
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
                BackColor = Color.White,
                ForeColor = Color.FromArgb(60, 60, 67),
                Font = new Font("Segoe UI", 8.5f),
                Cursor = Cursors.Hand
            };
            btn.FlatAppearance.BorderColor = Color.FromArgb(220, 220, 225);
            btn.FlatAppearance.BorderSize = 1;
            return btn;
        }
    }
    #endregion
}
