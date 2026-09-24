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
    #region 应用程序主入口与全局配置
    public class Program
    {
        public const string VERSION = "1.36.0";
        public const int PORT = 8307;
        public static string ServerUrl = "http://127.0.0.1:8306";
        public static string CacheDir;
        public static MainForm MainWindow;
        public static FloatingDockForm FloatingDock;
        public static ScreenOverlayForm OverlayCanvas;
        private static HttpListener httpListener;
        private static Thread serverThread;
        private static Thread seewoThread;
        private static bool isRunning = true;

        [STAThread]
        public static void Main(string[] args)
        {
            bool isNew;
            using (Mutex mutex = new Mutex(true, "FLA_Desktop_Mutex_136", out isNew))
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

                // 初始化缓存目录
                CacheDir = Path.Combine(Path.GetTempPath(), "FLA_Cache");
                try { if (!Directory.Exists(CacheDir)) Directory.CreateDirectory(CacheDir); } catch { }

                LoadConfig();
                RegisterProtocol();
                StartLocalServer();
                StartSeewoInterceptor();

                MainWindow = new MainForm();
                OverlayCanvas = new ScreenOverlayForm();
                FloatingDock = new FloatingDockForm();

                if (args.Length > 0 && args[0].StartsWith("fla://", StringComparison.OrdinalIgnoreCase))
                {
                    HandleProtocolUrl(args[0]);
                }

                Application.Run(MainWindow);
                isRunning = false;
                try { if (httpListener != null) httpListener.Stop(); } catch { }
            }
        }

        private static void LoadConfig()
        {
            try
            {
                string cfgFile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FLA", "config.ini");
                if (File.Exists(cfgFile))
                {
                    foreach (string line in File.ReadAllLines(cfgFile))
                    {
                        if (line.StartsWith("ServerUrl=", StringComparison.OrdinalIgnoreCase))
                        {
                            string url = line.Substring(10).Trim();
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
                string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FLA");
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                string cfgFile = Path.Combine(dir, "config.ini");
                File.WriteAllText(cfgFile, "ServerUrl=" + ServerUrl + "\r\nVersion=" + VERSION);
            }
            catch { }
        }

        private static void RegisterProtocol()
        {
            try
            {
                string exePath = Application.ExecutablePath;
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Classes\fla"))
                {
                    if (key != null)
                    {
                        key.SetValue("", "URL:FLA Protocol");
                        key.SetValue("URL Protocol", "");
                        using (RegistryKey cmdKey = key.CreateSubKey(@"shell\open\command"))
                        {
                            if (cmdKey != null) cmdKey.SetValue("", "\"" + exePath + "\" \"%1\"");
                        }
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

        private static void StartLocalServer()
        {
            serverThread = new Thread(() =>
            {
                try
                {
                    httpListener = new HttpListener();
                    httpListener.Prefixes.Add("http://127.0.0.1:" + PORT + "/");
                    httpListener.Start();

                    while (isRunning && httpListener.IsListening)
                    {
                        try
                        {
                            HttpListenerContext ctx = httpListener.GetContext();
                            ThreadPool.QueueUserWorkItem(ProcessHttpRequest, ctx);
                        }
                        catch { }
                    }
                }
                catch { }
            })
            { IsBackground = true };
            serverThread.Start();
        }

        private static void ProcessHttpRequest(object state)
        {
            HttpListenerContext ctx = (HttpListenerContext)state;
            try
            {
                ctx.Response.Headers.Add("Access-Control-Allow-Origin", "*");
                ctx.Response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
                ctx.Response.Headers.Add("Access-Control-Allow-Headers", "Content-Type, Authorization");

                if (ctx.Request.HttpMethod == "OPTIONS")
                {
                    ctx.Response.StatusCode = 204;
                    ctx.Response.Close();
                    return;
                }

                string path = ctx.Request.Url.AbsolutePath;
                if (path == "/api/ping" || path == "/ping")
                {
                    SendJson(ctx, 200, "{\"ok\":true,\"version\":\"" + VERSION + "\",\"app\":\"FLA Desktop\"}");
                    return;
                }

                if (path == "/api/open" && ctx.Request.HttpMethod == "POST")
                {
                    string body = ReadBody(ctx);
                    string url = GetJsonVal(body, "url");
                    string name = GetJsonVal(body, "name");
                    string token = GetJsonVal(body, "token");
                    if (!string.IsNullOrEmpty(url))
                    {
                        ThreadPool.QueueUserWorkItem(o => LaunchOfficePresentation(url, name, token));
                        SendJson(ctx, 200, "{\"ok\":true,\"msg\":\"正在调起本地系统默认 PowerPoint / WPS 播放…\"}");
                    }
                    else
                    {
                        SendJson(ctx, 400, "{\"ok\":false,\"error\":\"缺少课件 URL\"}");
                    }
                    return;
                }

                if (path == "/api/protocol" && ctx.Request.HttpMethod == "POST")
                {
                    string body = ReadBody(ctx);
                    string uri = GetJsonVal(body, "uri");
                    if (!string.IsNullOrEmpty(uri))
                    {
                        MainWindow.BeginInvoke(new Action(() => HandleProtocolUrl(uri)));
                    }
                    SendJson(ctx, 200, "{\"ok\":true}");
                    return;
                }

                SendJson(ctx, 404, "{\"ok\":false,\"error\":\"Not Found\"}");
            }
            catch { }
        }

        private static void SendJson(HttpListenerContext ctx, int code, string json)
        {
            try
            {
                byte[] buf = Encoding.UTF8.GetBytes(json);
                ctx.Response.StatusCode = code;
                ctx.Response.ContentType = "application/json; charset=utf-8";
                ctx.Response.ContentLength64 = buf.Length;
                ctx.Response.OutputStream.Write(buf, 0, buf.Length);
                ctx.Response.Close();
            }
            catch { }
        }

        private static string ReadBody(HttpListenerContext ctx)
        {
            using (StreamReader sr = new StreamReader(ctx.Request.InputStream, Encoding.UTF8))
            {
                return sr.ReadToEnd();
            }
        }

        public static string GetJsonVal(string json, string key)
        {
            try
            {
                string pat = "\"" + key + "\":";
                int idx = json.IndexOf(pat);
                if (idx == -1) return "";
                int start = idx + pat.Length;
                while (start < json.Length && (json[start] == ' ' || json[start] == '\"')) start++;
                int end = start;
                while (end < json.Length && json[end] != '\"' && json[end] != ',' && json[end] != '}') end++;
                return json.Substring(start, end - start).Trim();
            }
            catch { return ""; }
        }

        public static void HandleProtocolUrl(string url)
        {
            try
            {
                Uri u = new Uri(url);
                string q = u.Query.TrimStart('?');
                string fileUrl = "", fileName = "presentation.pptx", token = "";
                foreach (string part in q.Split('&'))
                {
                    string[] kv = part.Split('=');
                    if (kv.Length >= 2)
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
                    ThreadPool.QueueUserWorkItem(o => LaunchOfficePresentation(fileUrl, fileName, token));
                }
            }
            catch { }
        }

        public static void LaunchOfficePresentation(string fileUrl, string fileName, string token)
        {
            try
            {
                string safeName = Path.GetFileName(fileName);
                if (string.IsNullOrEmpty(safeName)) safeName = "presentation.pptx";
                string localPath = Path.Combine(CacheDir, safeName);

                using (WebClient wc = new WebClient())
                {
                    if (!string.IsNullOrEmpty(token)) wc.Headers["Authorization"] = "Bearer " + token;
                    wc.DownloadFile(fileUrl, localPath);
                }

                // 优先查找系统 PowerPoint / WPS
                string ext = Path.GetExtension(localPath).ToLower();
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = localPath;
                psi.UseShellExecute = true;

                // 若为演示文稿，尝试带 /s 参数直接全屏放映
                if (ext == ".pptx" || ext == ".ppt" || ext == ".pps" || ext == ".ppsx")
                {
                    string pptApp = FindPresentationApp();
                    if (!string.IsNullOrEmpty(pptApp))
                    {
                        psi.FileName = pptApp;
                        psi.Arguments = "/s \"" + localPath + "\"";
                    }
                }

                Process.Start(psi);

                // 唤起浮动交互胶囊
                if (MainWindow != null)
                {
                    MainWindow.BeginInvoke(new Action(() =>
                    {
                        if (FloatingDock != null) FloatingDock.ShowDock();
                    }));
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("打开本地课件失败: " + ex.Message, "FLA 课堂助手", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private static string FindPresentationApp()
        {
            string[] candidates = new string[]
            {
                @"C:\Program Files\Microsoft Office\root\Office16\POWERPNT.EXE",
                @"C:\Program Files (x86)\Microsoft Office\root\Office16\POWERPNT.EXE",
                @"C:\Program Files\Microsoft Office\Office15\POWERPNT.EXE",
                @"C:\Program Files (x86)\Microsoft Office\Office15\POWERPNT.EXE",
                @"C:\Program Files\Microsoft Office\Office14\POWERPNT.EXE",
                @"C:\Program Files (x86)\Microsoft Office\Office14\POWERPNT.EXE",
                @"C:\Program Files\Kingsoft\WPS Office\ksolaunch.exe",
                @"C:\Program Files (x86)\Kingsoft\WPS Office\ksolaunch.exe"
            };
            foreach (string p in candidates)
            {
                if (File.Exists(p)) return p;
            }
            return "";
        }

        private static void StartSeewoInterceptor()
        {
            seewoThread = new Thread(() =>
            {
                while (isRunning)
                {
                    try
                    {
                        // 检索希沃白板5注入窗口并抑制其焦点抢占
                        IntPtr hwnd = FindWindow("EasiNote_Toolbar", null);
                        if (hwnd == IntPtr.Zero) hwnd = FindWindow(null, "希沃教学助手");
                        if (hwnd != IntPtr.Zero)
                        {
                            ShowWindow(hwnd, 0); // 0 = SW_HIDE
                        }
                    }
                    catch { }
                    Thread.Sleep(1500);
                }
            })
            { IsBackground = true };
            seewoThread.Start();
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    }
    #endregion

    #region 课件数据模型
    public class CloudFileItem
    {
        public int Id { get; set; }
        public string Name { get; set; }
        public string Ext { get; set; }
        public string Kind { get; set; }
        public long Size { get; set; }
        public int Pages { get; set; }
        public string CreatedAt { get; set; }
        public string Status { get; set; }
    }
    #endregion

    #region 主窗体 (从零实现，现代原生 WinForms + 希沃护眼翠绿配色)
    public class MainForm : Form
    {
        private Panel headerPanel;
        private Panel tabContainer;
        private Panel cloudTabPanel;
        private Panel castingTabPanel;
        private Button btnTabCloud;
        private Button btnTabCast;
        private Label lblServerStatus;

        // 云存储控件
        private TextBox txtSearch;
        private DataGridView dgvCloudFiles;
        private Label lblStorageSummary;
        private Button btnUpload;
        private Button btnRefresh;
        private List<CloudFileItem> currentFileList = new List<CloudFileItem>();

        // 投屏放映控件
        private Label lblCastingCode;
        private PictureBox picQrCode;
        private Label lblRemoteStatus;
        private Button btnNewCode;
        private Button btnStartProjection;
        private Button btnToggleDock;
        private System.Windows.Forms.Timer remotePollTimer;
        private string currentSessionId = "";
        private string currentPairCode = "8306";

        public MainForm()
        {
            InitializeComponent();
            RefreshServerState();
            LoadCloudFiles();
            InitCastingSession();
        }

        private void InitializeComponent()
        {
            this.Text = "FLA 智慧互动教学助手 · 原生桌面客户端 v" + Program.VERSION;
            this.Size = new Size(1060, 690);
            this.MinimumSize = new Size(900, 580);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = Color.FromArgb(18, 19, 22);      // 深墨温润底色 (Obsidian)
            this.ForeColor = Color.FromArgb(248, 250, 252);
            this.Font = new Font("Segoe UI", 9.5f);
            this.Icon = SystemIcons.Application;

            // 1. 顶部 Header (高度 62)
            headerPanel = new Panel
            {
                Dock = DockStyle.Top,
                Height = 62,
                BackColor = Color.FromArgb(24, 25, 29)
            };
            headerPanel.Paint += (s, e) =>
            {
                using (Pen p = new Pen(Color.FromArgb(39, 40, 48), 1))
                {
                    e.Graphics.DrawLine(p, 0, headerPanel.Height - 1, headerPanel.Width, headerPanel.Height - 1);
                }
            };

            // Logo Badge
            Panel logoBadge = new Panel
            {
                Size = new Size(36, 36),
                Location = new Point(18, 13),
                BackColor = Color.FromArgb(0, 176, 111) // 希沃翡翠绿
            };
            logoBadge.Paint += (s, e) =>
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using (Font f = new Font("Segoe UI", 11.5f, FontStyle.Bold))
                using (Brush b = new SolidBrush(Color.White))
                {
                    StringFormat sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
                    e.Graphics.DrawString("FLA", f, b, new RectangleF(0, 0, 36, 36), sf);
                }
            };

            Label lblTitle = new Label
            {
                Text = "FLA 智慧教学助手",
                Font = new Font("Segoe UI", 12.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(248, 250, 252),
                Location = new Point(62, 12),
                AutoSize = true
            };

            Label lblVersion = new Label
            {
                Text = "v" + Program.VERSION + " · 纯原生桌面端 (云存储 + 智能投屏)",
                Font = new Font("Segoe UI", 8.5f),
                ForeColor = Color.FromArgb(148, 163, 184),
                Location = new Point(64, 35),
                AutoSize = true
            };

            // 服务器连接状态标签
            lblServerStatus = new Label
            {
                Text = "● 正在连接服务器…",
                Font = new Font("Segoe UI", 9f, FontStyle.Bold),
                ForeColor = Color.FromArgb(0, 176, 111),
                Location = new Point(480, 22),
                AutoSize = true
            };

            // 设置服务器按钮
            Button btnServerCfg = CreateHeaderButton("⚙️ 服务器设置", 670, 15, 120);
            btnServerCfg.Click += (s, e) => ShowServerConfigDialog();

            // 刷新按钮
            Button btnHeaderRefresh = CreateHeaderButton("🔄 刷新", 800, 15, 80);
            btnHeaderRefresh.Click += (s, e) =>
            {
                RefreshServerState();
                LoadCloudFiles();
                InitCastingSession();
            };

            headerPanel.Controls.Add(logoBadge);
            headerPanel.Controls.Add(lblTitle);
            headerPanel.Controls.Add(lblVersion);
            headerPanel.Controls.Add(lblServerStatus);
            headerPanel.Controls.Add(btnServerCfg);
            headerPanel.Controls.Add(btnHeaderRefresh);

            // 2. 导航栏 (高度 46)
            Panel navBar = new Panel
            {
                Dock = DockStyle.Top,
                Height = 46,
                BackColor = Color.FromArgb(24, 25, 29)
            };
            navBar.Paint += (s, e) =>
            {
                using (Pen p = new Pen(Color.FromArgb(39, 40, 48), 1))
                {
                    e.Graphics.DrawLine(p, 0, navBar.Height - 1, navBar.Width, navBar.Height - 1);
                }
            };

            btnTabCloud = CreateNavTabButton("☁️  云端课件存储", 20, 4, 160, true);
            btnTabCast = CreateNavTabButton("📺  智能投屏放映", 190, 4, 160, false);

            btnTabCloud.Click += (s, e) => SwitchTab(true);
            btnTabCast.Click += (s, e) => SwitchTab(false);

            navBar.Controls.Add(btnTabCloud);
            navBar.Controls.Add(btnTabCast);

            // 3. 内容容器
            tabContainer = new Panel
            {
                Dock = DockStyle.Fill,
                BackColor = Color.FromArgb(18, 19, 22)
            };

            // 创建两个核心功能面板
            InitCloudTab();
            InitCastingTab();

            tabContainer.Controls.Add(cloudTabPanel);
            tabContainer.Controls.Add(castingTabPanel);

            this.Controls.Add(tabContainer);
            this.Controls.Add(navBar);
            this.Controls.Add(headerPanel);

            SwitchTab(true);
        }

        private Button CreateHeaderButton(string text, int x, int y, int width)
        {
            Button btn = new Button
            {
                Text = text,
                Location = new Point(x, y),
                Size = new Size(width, 32),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(34, 35, 41),
                ForeColor = Color.FromArgb(241, 245, 249),
                Font = new Font("Segoe UI", 9f),
                Cursor = Cursors.Hand
            };
            btn.FlatAppearance.BorderColor = Color.FromArgb(50, 51, 61);
            btn.FlatAppearance.MouseOverBackColor = Color.FromArgb(45, 46, 56);
            return btn;
        }

        private Button CreateNavTabButton(string text, int x, int y, int width, bool active)
        {
            Button btn = new Button
            {
                Text = text,
                Location = new Point(x, y),
                Size = new Size(width, 38),
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 10f, FontStyle.Bold),
                Cursor = Cursors.Hand,
                TextAlign = ContentAlignment.MiddleCenter
            };
            UpdateTabStyle(btn, active);
            return btn;
        }

        private void UpdateTabStyle(Button btn, bool active)
        {
            if (active)
            {
                btn.BackColor = Color.FromArgb(18, 19, 22);
                btn.ForeColor = Color.FromArgb(0, 176, 111); // 翡翠绿
                btn.FlatAppearance.BorderColor = Color.FromArgb(0, 176, 111);
                btn.FlatAppearance.BorderSize = 2;
            }
            else
            {
                btn.BackColor = Color.Transparent;
                btn.ForeColor = Color.FromArgb(148, 163, 184);
                btn.FlatAppearance.BorderColor = Color.FromArgb(24, 25, 29);
                btn.FlatAppearance.BorderSize = 0;
            }
        }

        private void SwitchTab(bool showCloud)
        {
            UpdateTabStyle(btnTabCloud, showCloud);
            UpdateTabStyle(btnTabCast, !showCloud);
            cloudTabPanel.Visible = showCloud;
            castingTabPanel.Visible = !showCloud;
        }

        #region 云存储功能面板
        private void InitCloudTab()
        {
            cloudTabPanel = new Panel
            {
                Dock = DockStyle.Fill,
                BackColor = Color.FromArgb(18, 19, 22),
                Padding = new Padding(20)
            };

            // 顶部操作栏
            Panel actionPanel = new Panel
            {
                Dock = DockStyle.Top,
                Height = 48,
                BackColor = Color.Transparent
            };

            // 搜索框
            txtSearch = new TextBox
            {
                Location = new Point(0, 8),
                Size = new Size(260, 30),
                Font = new Font("Segoe UI", 10f),
                BackColor = Color.FromArgb(26, 27, 32),
                ForeColor = Color.White,
                BorderStyle = BorderStyle.FixedSingle
            };
            txtSearch.TextChanged += (s, e) => FilterFiles(txtSearch.Text);

            Label lblSearchIcon = new Label
            {
                Text = "🔍 搜索课件名称…",
                ForeColor = Color.FromArgb(100, 116, 139),
                Location = new Point(txtSearch.Right + 8, 12),
                AutoSize = true
            };

            // 上传课件按钮
            btnUpload = new Button
            {
                Text = "📤 上传课件到云端",
                Size = new Size(160, 34),
                Location = new Point(620, 6),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(0, 176, 111),
                ForeColor = Color.White,
                Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btnUpload.FlatAppearance.BorderSize = 0;
            btnUpload.Click += (s, e) => UploadFileToCloud();

            // 刷新列表按钮
            btnRefresh = new Button
            {
                Text = "🔄 刷新列表",
                Size = new Size(100, 34),
                Location = new Point(790, 6),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(34, 35, 41),
                ForeColor = Color.FromArgb(241, 245, 249),
                Font = new Font("Segoe UI", 9f),
                Cursor = Cursors.Hand
            };
            btnRefresh.FlatAppearance.BorderColor = Color.FromArgb(50, 51, 61);
            btnRefresh.Click += (s, e) => LoadCloudFiles();

            actionPanel.Controls.Add(txtSearch);
            actionPanel.Controls.Add(lblSearchIcon);
            actionPanel.Controls.Add(btnUpload);
            actionPanel.Controls.Add(btnRefresh);

            // 数据表格
            dgvCloudFiles = new DataGridView
            {
                Dock = DockStyle.Fill,
                BackgroundColor = Color.FromArgb(22, 23, 27),
                BorderStyle = BorderStyle.None,
                CellBorderStyle = DataGridViewCellBorderStyle.SingleHorizontal,
                GridColor = Color.FromArgb(39, 40, 48),
                RowHeadersVisible = false,
                AllowUserToAddRows = false,
                AllowUserToDeleteRows = false,
                ReadOnly = true,
                SelectionMode = DataGridViewSelectionMode.FullRowSelect,
                MultiSelect = false,
                RowTemplate = { Height = 42 },
                EnableHeadersVisualStyles = false,
                Font = new Font("Segoe UI", 9.5f)
            };

            dgvCloudFiles.ColumnHeadersDefaultCellStyle.BackColor = Color.FromArgb(30, 31, 37);
            dgvCloudFiles.ColumnHeadersDefaultCellStyle.ForeColor = Color.FromArgb(148, 163, 184);
            dgvCloudFiles.ColumnHeadersDefaultCellStyle.Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
            dgvCloudFiles.ColumnHeadersHeight = 38;

            dgvCloudFiles.DefaultCellStyle.BackColor = Color.FromArgb(22, 23, 27);
            dgvCloudFiles.DefaultCellStyle.ForeColor = Color.FromArgb(241, 245, 249);
            dgvCloudFiles.DefaultCellStyle.SelectionBackColor = Color.FromArgb(35, 55, 45); // 翡翠微选色
            dgvCloudFiles.DefaultCellStyle.SelectionForeColor = Color.FromArgb(167, 243, 208);

            // 列定义
            dgvCloudFiles.Columns.Add("id", "ID");
            dgvCloudFiles.Columns["id"].Visible = false;

            dgvCloudFiles.Columns.Add("name", "课件名称");
            dgvCloudFiles.Columns["name"].Width = 380;

            dgvCloudFiles.Columns.Add("kind", "类型");
            dgvCloudFiles.Columns["kind"].Width = 80;

            dgvCloudFiles.Columns.Add("size", "大小");
            dgvCloudFiles.Columns["size"].Width = 100;

            dgvCloudFiles.Columns.Add("pages", "页数");
            dgvCloudFiles.Columns["pages"].Width = 80;

            dgvCloudFiles.Columns.Add("date", "上传时间");
            dgvCloudFiles.Columns["date"].Width = 160;

            // 双击快速放映
            dgvCloudFiles.CellDoubleClick += (s, e) =>
            {
                if (e.RowIndex >= 0) PlayCurrentSelectedRow();
            };

            // 底部操作区
            Panel bottomPanel = new Panel
            {
                Dock = DockStyle.Bottom,
                Height = 54,
                BackColor = Color.Transparent,
                Padding = new Padding(0, 10, 0, 0)
            };

            lblStorageSummary = new Label
            {
                Text = "正在读取云端课件列表…",
                ForeColor = Color.FromArgb(148, 163, 184),
                Location = new Point(0, 16),
                AutoSize = true
            };

            Button btnPlaySelected = new Button
            {
                Text = "🖥️ 一键本地放映",
                Size = new Size(150, 36),
                Location = new Point(560, 8),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(0, 176, 111),
                ForeColor = Color.White,
                Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btnPlaySelected.FlatAppearance.BorderSize = 0;
            btnPlaySelected.Click += (s, e) => PlayCurrentSelectedRow();

            Button btnDownloadSelected = new Button
            {
                Text = "📥 下载课件",
                Size = new Size(110, 36),
                Location = new Point(720, 8),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(34, 35, 41),
                ForeColor = Color.FromArgb(241, 245, 249),
                Font = new Font("Segoe UI", 9f),
                Cursor = Cursors.Hand
            };
            btnDownloadSelected.FlatAppearance.BorderColor = Color.FromArgb(50, 51, 61);
            btnDownloadSelected.Click += (s, e) => DownloadCurrentSelectedRow();

            bottomPanel.Controls.Add(lblStorageSummary);
            bottomPanel.Controls.Add(btnPlaySelected);
            bottomPanel.Controls.Add(btnDownloadSelected);

            cloudTabPanel.Controls.Add(dgvCloudFiles);
            cloudTabPanel.Controls.Add(bottomPanel);
            cloudTabPanel.Controls.Add(actionPanel);
        }

        private void LoadCloudFiles()
        {
            ThreadPool.QueueUserWorkItem(o =>
            {
                try
                {
                    using (WebClient wc = new WebClient())
                    {
                        wc.Encoding = Encoding.UTF8;
                        string json = wc.DownloadString(Program.ServerUrl + "/api/files");
                        List<CloudFileItem> list = ParseFilesJson(json);
                        this.BeginInvoke(new Action(() =>
                        {
                            currentFileList = list;
                            FilterFiles(txtSearch != null ? txtSearch.Text : "");
                        }));
                    }
                }
                catch (Exception ex)
                {
                    this.BeginInvoke(new Action(() =>
                    {
                        if (lblStorageSummary != null)
                            lblStorageSummary.Text = "无法连接云端文件服务 (" + ex.Message + ")";
                    }));
                }
            });
        }

        private List<CloudFileItem> ParseFilesJson(string json)
        {
            List<CloudFileItem> items = new List<CloudFileItem>();
            try
            {
                int idx = 0;
                while ((idx = json.IndexOf("{\"id\":", idx)) != -1)
                {
                    int end = json.IndexOf("}", idx);
                    if (end == -1) break;
                    string block = json.Substring(idx, end - idx + 1);

                    CloudFileItem item = new CloudFileItem();
                    int id;
                    if (int.TryParse(Program.GetJsonVal(block, "id"), out id)) item.Id = id;
                    item.Name = Program.GetJsonVal(block, "orig_name");
                    if (string.IsNullOrEmpty(item.Name)) item.Name = Program.GetJsonVal(block, "name");
                    item.Ext = Program.GetJsonVal(block, "ext");
                    item.Kind = Program.GetJsonVal(block, "kind");
                    long size;
                    if (long.TryParse(Program.GetJsonVal(block, "size"), out size)) item.Size = size;
                    int pages;
                    if (int.TryParse(Program.GetJsonVal(block, "pages"), out pages)) item.Pages = pages;
                    item.CreatedAt = Program.GetJsonVal(block, "created_at");
                    item.Status = Program.GetJsonVal(block, "status");

                    if (!string.IsNullOrEmpty(item.Name)) items.Add(item);
                    idx = end + 1;
                }
            }
            catch { }
            return items;
        }

        private void FilterFiles(string keyword)
        {
            dgvCloudFiles.Rows.Clear();
            long totalSize = 0;
            int count = 0;

            foreach (var f in currentFileList)
            {
                if (!string.IsNullOrEmpty(keyword) && !f.Name.ToLower().Contains(keyword.ToLower()))
                    continue;

                count++;
                totalSize += f.Size;
                string sizeStr = (f.Size / 1024.0 / 1024.0).ToString("0.0") + " MB";
                if (f.Size < 1024 * 1024) sizeStr = (f.Size / 1024.0).ToString("0") + " KB";
                string pageStr = f.Pages > 0 ? f.Pages + " 页" : "-";

                dgvCloudFiles.Rows.Add(f.Id, f.Name, f.Ext.ToUpper(), sizeStr, pageStr, f.CreatedAt);
            }

            lblStorageSummary.Text = "共 " + count + " 份课件 · 已用存储空间 " + (totalSize / 1024.0 / 1024.0).ToString("0.1") + " MB";
        }

        private void PlayCurrentSelectedRow()
        {
            if (dgvCloudFiles.SelectedRows.Count == 0)
            {
                MessageBox.Show("请先选择要放映的课件。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            int id = Convert.ToInt32(dgvCloudFiles.SelectedRows[0].Cells["id"].Value);
            string name = dgvCloudFiles.SelectedRows[0].Cells["name"].Value.ToString();
            string downloadUrl = Program.ServerUrl + "/api/files/" + id + "/download";

            Program.LaunchOfficePresentation(downloadUrl, name, "");
        }

        private void DownloadCurrentSelectedRow()
        {
            if (dgvCloudFiles.SelectedRows.Count == 0) return;
            int id = Convert.ToInt32(dgvCloudFiles.SelectedRows[0].Cells["id"].Value);
            string name = dgvCloudFiles.SelectedRows[0].Cells["name"].Value.ToString();

            using (SaveFileDialog sfd = new SaveFileDialog())
            {
                sfd.FileName = name;
                if (sfd.ShowDialog() == DialogResult.OK)
                {
                    try
                    {
                        using (WebClient wc = new WebClient())
                        {
                            wc.DownloadFile(Program.ServerUrl + "/api/files/" + id + "/download", sfd.FileName);
                        }
                        MessageBox.Show("课件《" + name + "》已成功下载！", "下载完成", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }
                    catch (Exception ex)
                    {
                        MessageBox.Show("下载失败: " + ex.Message, "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    }
                }
            }
        }

        private void UploadFileToCloud()
        {
            using (OpenFileDialog ofd = new OpenFileDialog())
            {
                ofd.Title = "选择要上传到云端的课件文件";
                ofd.Filter = "教学课件 (*.pptx;*.ppt;*.pdf;*.docx;*.mp4;*.png)|*.pptx;*.ppt;*.pdf;*.docx;*.mp4;*.png|所有文件 (*.*)|*.*";
                if (ofd.ShowDialog() == DialogResult.OK)
                {
                    string filePath = ofd.FileName;
                    string fileName = Path.GetFileName(filePath);
                    btnUpload.Enabled = false;
                    btnUpload.Text = "正在上传…";

                    ThreadPool.QueueUserWorkItem(o =>
                    {
                        try
                        {
                            using (WebClient wc = new WebClient())
                            {
                                byte[] resp = wc.UploadFile(Program.ServerUrl + "/api/files/upload", "POST", filePath);
                            }
                            this.BeginInvoke(new Action(() =>
                            {
                                MessageBox.Show("课件《" + fileName + "》已成功上传到云端！", "上传成功", MessageBoxButtons.OK, MessageBoxIcon.Information);
                                btnUpload.Enabled = true;
                                btnUpload.Text = "📤 上传课件到云端";
                                LoadCloudFiles();
                            }));
                        }
                        catch (Exception ex)
                        {
                            this.BeginInvoke(new Action(() =>
                            {
                                MessageBox.Show("上传失败: " + ex.Message, "上传失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                                btnUpload.Enabled = true;
                                btnUpload.Text = "📤 上传课件到云端";
                            }));
                        }
                    });
                }
            }
        }
        #endregion

        #region 智能投屏功能面板
        private void InitCastingTab()
        {
            castingTabPanel = new Panel
            {
                Dock = DockStyle.Fill,
                BackColor = Color.FromArgb(18, 19, 22),
                Padding = new Padding(24)
            };

            // 投屏大卡片
            Panel castCard = new Panel
            {
                Size = new Size(420, 500),
                Location = new Point(30, 20),
                BackColor = Color.FromArgb(24, 25, 29)
            };
            castCard.Paint += (s, e) =>
            {
                using (Pen p = new Pen(Color.FromArgb(39, 40, 48), 1))
                {
                    e.Graphics.DrawRectangle(p, 0, 0, castCard.Width - 1, castCard.Height - 1);
                }
            };

            Label lblCardTitle = new Label
            {
                Text = "手机扫码投屏与课堂遥控",
                Font = new Font("Segoe UI", 13f, FontStyle.Bold),
                ForeColor = Color.White,
                Location = new Point(20, 20),
                AutoSize = true
            };

            Label lblCardSub = new Label
            {
                Text = "微信或浏览器扫码，手机无需装 App 即可遥控大屏",
                Font = new Font("Segoe UI", 9f),
                ForeColor = Color.FromArgb(148, 163, 184),
                Location = new Point(22, 48),
                AutoSize = true
            };

            // 二维码 PictureBox
            picQrCode = new PictureBox
            {
                Size = new Size(180, 180),
                Location = new Point(120, 80),
                BackColor = Color.White,
                SizeMode = PictureBoxSizeMode.CenterImage
            };

            Label lblCodeTip = new Label
            {
                Text = "或在手机端输入 4 位投屏配对码：",
                Font = new Font("Segoe UI", 9.5f),
                ForeColor = Color.FromArgb(148, 163, 184),
                Location = new Point(90, 275),
                AutoSize = true
            };

            lblCastingCode = new Label
            {
                Text = currentPairCode,
                Font = new Font("Segoe UI", 36f, FontStyle.Bold),
                ForeColor = Color.FromArgb(0, 176, 111), // 翡翠绿
                Location = new Point(110, 305),
                Size = new Size(200, 60),
                TextAlign = ContentAlignment.MiddleCenter
            };

            lblRemoteStatus = new Label
            {
                Text = "● 等待手机连接…",
                Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(245, 158, 11),
                Location = new Point(140, 380),
                AutoSize = true
            };

            btnNewCode = new Button
            {
                Text = "🔄 更换配对码",
                Size = new Size(160, 36),
                Location = new Point(130, 420),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(34, 35, 41),
                ForeColor = Color.White,
                Font = new Font("Segoe UI", 9f),
                Cursor = Cursors.Hand
            };
            btnNewCode.FlatAppearance.BorderColor = Color.FromArgb(50, 51, 61);
            btnNewCode.Click += (s, e) => InitCastingSession();

            castCard.Controls.Add(lblCardTitle);
            castCard.Controls.Add(lblCardSub);
            castCard.Controls.Add(picQrCode);
            castCard.Controls.Add(lblCodeTip);
            castCard.Controls.Add(lblCastingCode);
            castCard.Controls.Add(lblRemoteStatus);
            castCard.Controls.Add(btnNewCode);

            // 右侧投屏快捷控制卡片
            Panel rightCtrlPanel = new Panel
            {
                Size = new Size(480, 500),
                Location = new Point(480, 20),
                BackColor = Color.FromArgb(24, 25, 29),
                Padding = new Padding(24)
            };
            rightCtrlPanel.Paint += (s, e) =>
            {
                using (Pen p = new Pen(Color.FromArgb(39, 40, 48), 1))
                {
                    e.Graphics.DrawRectangle(p, 0, 0, rightCtrlPanel.Width - 1, rightCtrlPanel.Height - 1);
                }
            };

            Label lblCtrlTitle = new Label
            {
                Text = "投屏模式与交互工具",
                Font = new Font("Segoe UI", 13f, FontStyle.Bold),
                ForeColor = Color.White,
                Location = new Point(20, 20),
                AutoSize = true
            };

            btnStartProjection = new Button
            {
                Text = "🚀 开启全屏投屏演示模式",
                Size = new Size(380, 48),
                Location = new Point(20, 70),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(0, 176, 111),
                ForeColor = Color.White,
                Font = new Font("Segoe UI", 11f, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btnStartProjection.FlatAppearance.BorderSize = 0;
            btnStartProjection.Click += (s, e) =>
            {
                if (Program.OverlayCanvas != null) Program.OverlayCanvas.ShowOverlay();
                if (Program.FloatingDock != null) Program.FloatingDock.ShowDock();
            };

            btnToggleDock = new Button
            {
                Text = "🪟 呼出悬浮教学工具胶囊 (希沃替代条)",
                Size = new Size(380, 44),
                Location = new Point(20, 130),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(34, 35, 41),
                ForeColor = Color.White,
                Font = new Font("Segoe UI", 10f),
                Cursor = Cursors.Hand
            };
            btnToggleDock.FlatAppearance.BorderColor = Color.FromArgb(50, 51, 61);
            btnToggleDock.Click += (s, e) =>
            {
                if (Program.FloatingDock != null) Program.FloatingDock.ToggleDock();
            };

            // 功能优势介绍
            Label lblFeatures = new Label
            {
                Text = "💡 FLA 桌面客户端核心优势：\n\n" +
                       "1. 纯原生高性能架构：启动零等待，无需等待浏览器加载；\n" +
                       "2. 希沃白板5自动压制：拦截希沃冲突窗口，还大屏清爽环境；\n" +
                       "3. 手机与电脑毫秒级互联：随时随地翻页、动画步进、红外激光笔；\n" +
                       "4. 边沿吸附式交互胶囊：不遮挡 PPT 画面，书写批注一键留存。",
                Font = new Font("Segoe UI", 9.5f),
                ForeColor = Color.FromArgb(148, 163, 184),
                Location = new Point(20, 200),
                Size = new Size(420, 240)
            };

            rightCtrlPanel.Controls.Add(lblCtrlTitle);
            rightCtrlPanel.Controls.Add(btnStartProjection);
            rightCtrlPanel.Controls.Add(btnToggleDock);
            rightCtrlPanel.Controls.Add(lblFeatures);

            castingTabPanel.Controls.Add(castCard);
            castingTabPanel.Controls.Add(rightCtrlPanel);

            // 遥控事件轮询定时器
            remotePollTimer = new System.Windows.Forms.Timer { Interval = 1000 };
            remotePollTimer.Tick += (s, e) => PollRemoteActions();
            remotePollTimer.Start();
        }

        private void InitCastingSession()
        {
            ThreadPool.QueueUserWorkItem(o =>
            {
                try
                {
                    using (WebClient wc = new WebClient())
                    {
                        wc.Headers[HttpRequestHeader.ContentType] = "application/json";
                        string req = "{\"title\":\"桌面端投屏放映\",\"total\":99}";
                        string resp = wc.UploadString(Program.ServerUrl + "/api/remote/create", "POST", req);
                        string sid = Program.GetJsonVal(resp, "session_id");
                        string code = Program.GetJsonVal(resp, "code");

                        if (!string.IsNullOrEmpty(sid))
                        {
                            currentSessionId = sid;
                            currentPairCode = code;

                            // 尝试载入服务端原生生成的 QR PNG
                            Image qrImg = null;
                            try
                            {
                                byte[] imgData = wc.DownloadData(Program.ServerUrl + "/api/remote/" + sid + "/qr");
                                using (MemoryStream ms = new MemoryStream(imgData))
                                {
                                    qrImg = Image.FromStream(ms);
                                }
                            }
                            catch { }

                            this.BeginInvoke(new Action(() =>
                            {
                                lblCastingCode.Text = currentPairCode;
                                if (qrImg != null)
                                {
                                    picQrCode.Image = qrImg;
                                }
                                else
                                {
                                    DrawFallbackQrCode(currentPairCode);
                                }
                            }));
                        }
                    }
                }
                catch
                {
                    this.BeginInvoke(new Action(() =>
                    {
                        DrawFallbackQrCode(currentPairCode);
                    }));
                }
            });
        }

        private void DrawFallbackQrCode(string code)
        {
            Bitmap bmp = new Bitmap(180, 180);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.White);
                using (Font f = new Font("Segoe UI", 12f, FontStyle.Bold))
                using (Brush b = new SolidBrush(Color.FromArgb(0, 176, 111)))
                {
                    g.DrawString("投屏二维码", f, b, 45, 60);
                }
                using (Font f2 = new Font("Segoe UI", 16f, FontStyle.Bold))
                using (Brush b2 = new SolidBrush(Color.Black))
                {
                    g.DrawString(code, f2, b2, 60, 90);
                }
            }
            picQrCode.Image = bmp;
        }

        private int lastRemoteActionIdx = 0;
        private void PollRemoteActions()
        {
            if (string.IsNullOrEmpty(currentSessionId)) return;
            ThreadPool.QueueUserWorkItem(o =>
            {
                try
                {
                    using (WebClient wc = new WebClient())
                    {
                        wc.Encoding = Encoding.UTF8;
                        string json = wc.DownloadString(Program.ServerUrl + "/api/remote/" + currentSessionId + "/poll?after=" + lastRemoteActionIdx);
                        if (json.Contains("\"action\":"))
                        {
                            this.BeginInvoke(new Action(() =>
                            {
                                lblRemoteStatus.Text = "✔ 手机已连接 (遥控中)";
                                lblRemoteStatus.ForeColor = Color.FromArgb(0, 176, 111);
                                ExecuteRemoteAction(json);
                            }));
                        }
                    }
                }
                catch { }
            });
        }

        private void ExecuteRemoteAction(string json)
        {
            try
            {
                if (json.Contains("\"action\":\"next\"") || json.Contains("\"action\":\"stepNext\""))
                {
                    SendKeys.SendWait("{PGDN}");
                }
                else if (json.Contains("\"action\":\"prev\"") || json.Contains("\"action\":\"stepPrev\""))
                {
                    SendKeys.SendWait("{PGUP}");
                }
                else if (json.Contains("\"action\":\"black\""))
                {
                    SendKeys.SendWait("b");
                }
            }
            catch { }
        }
        #endregion

        private void RefreshServerState()
        {
            ThreadPool.QueueUserWorkItem(o =>
            {
                try
                {
                    using (WebClient wc = new WebClient())
                    {
                        string resp = wc.DownloadString(Program.ServerUrl + "/api/health");
                        this.BeginInvoke(new Action(() =>
                        {
                            lblServerStatus.Text = "● 云端已连接 (" + Program.ServerUrl + ")";
                            lblServerStatus.ForeColor = Color.FromArgb(0, 176, 111);
                        }));
                    }
                }
                catch
                {
                    this.BeginInvoke(new Action(() =>
                    {
                        lblServerStatus.Text = "○ 离线模式 (" + Program.ServerUrl + ")";
                        lblServerStatus.ForeColor = Color.FromArgb(245, 158, 11);
                    }));
                }
            });
        }

        private void ShowServerConfigDialog()
        {
            using (Form dlg = new Form())
            {
                dlg.Text = "配置 FLA 云服务地址";
                dlg.Size = new Size(460, 220);
                dlg.StartPosition = FormStartPosition.CenterParent;
                dlg.BackColor = Color.FromArgb(24, 25, 29);
                dlg.ForeColor = Color.White;
                dlg.FormBorderStyle = FormBorderStyle.FixedDialog;
                dlg.MaximizeBox = false;
                dlg.MinimizeBox = false;

                Label lbl = new Label
                {
                    Text = "请输入 FLA 局域网或云端服务器地址 (例如 http://192.168.1.100:8306)：",
                    Location = new Point(20, 20),
                    Size = new Size(400, 36)
                };

                TextBox txt = new TextBox
                {
                    Text = Program.ServerUrl,
                    Location = new Point(22, 60),
                    Size = new Size(395, 28),
                    BackColor = Color.FromArgb(34, 35, 41),
                    ForeColor = Color.White,
                    Font = new Font("Segoe UI", 10f)
                };

                Button btnSave = new Button
                {
                    Text = "保存并测试",
                    Location = new Point(200, 110),
                    Size = new Size(110, 36),
                    BackColor = Color.FromArgb(0, 176, 111),
                    ForeColor = Color.White,
                    FlatStyle = FlatStyle.Flat,
                    DialogResult = DialogResult.OK
                };
                btnSave.FlatAppearance.BorderSize = 0;

                Button btnCancel = new Button
                {
                    Text = "取消",
                    Location = new Point(320, 110),
                    Size = new Size(95, 36),
                    BackColor = Color.FromArgb(45, 46, 56),
                    ForeColor = Color.White,
                    FlatStyle = FlatStyle.Flat,
                    DialogResult = DialogResult.Cancel
                };
                btnCancel.FlatAppearance.BorderSize = 0;

                dlg.Controls.Add(lbl);
                dlg.Controls.Add(txt);
                dlg.Controls.Add(btnSave);
                dlg.Controls.Add(btnCancel);

                if (dlg.ShowDialog() == DialogResult.OK)
                {
                    string newUrl = txt.Text.Trim().TrimEnd('/');
                    if (!string.IsNullOrEmpty(newUrl))
                    {
                        Program.ServerUrl = newUrl;
                        Program.SaveConfig();
                        RefreshServerState();
                        LoadCloudFiles();
                        InitCastingSession();
                    }
                }
            }
        }
    }
    #endregion

    #region 悬浮教学交互工具胶囊 (替代希沃白板5侧边栏)
    public class FloatingDockForm : Form
    {
        private bool isDragging = false;
        private Point dragCursorPoint;
        private Point dragFormPoint;

        public FloatingDockForm()
        {
            this.FormBorderStyle = FormBorderStyle.None;
            this.StartPosition = FormStartPosition.Manual;
            this.Size = new Size(360, 50);
            this.Location = new Point(Screen.PrimaryScreen.WorkingArea.Width - 380, Screen.PrimaryScreen.WorkingArea.Height - 80);
            this.TopMost = true;
            this.ShowInTaskbar = false;
            this.BackColor = Color.FromArgb(24, 25, 29);
            this.DoubleBuffered = true;

            InitDockButtons();

            this.MouseDown += (s, e) =>
            {
                if (e.Button == MouseButtons.Left)
                {
                    isDragging = true;
                    dragCursorPoint = Cursor.Position;
                    dragFormPoint = this.Location;
                }
            };
            this.MouseMove += (s, e) =>
            {
                if (isDragging)
                {
                    Point diff = Point.Subtract(Cursor.Position, new Size(dragCursorPoint));
                    this.Location = Point.Add(dragFormPoint, new Size(diff));
                }
            };
            this.MouseUp += (s, e) => { isDragging = false; };
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (Pen p = new Pen(Color.FromArgb(0, 176, 111), 1.5f))
            {
                e.Graphics.DrawRectangle(p, 0, 0, this.Width - 1, this.Height - 1);
            }
        }

        private void InitDockButtons()
        {
            int x = 10;
            AddBtn("‹ 上页", x, () => SendKeys.SendWait("{PGUP}"));
            x += 54;
            AddBtn("下页 ›", x, () => SendKeys.SendWait("{PGDN}"));
            x += 54;
            AddBtn("🔴 激光", x, () =>
            {
                if (Program.OverlayCanvas != null) Program.OverlayCanvas.ToggleLaser();
            });
            x += 58;
            AddBtn("✏️ 荧光", x, () =>
            {
                if (Program.OverlayCanvas != null) Program.OverlayCanvas.TogglePen();
            });
            x += 58;
            AddBtn("⬛ 黑屏", x, () => SendKeys.SendWait("b"));
            x += 58;
            AddBtn("✕ 隐藏", x, () => this.Hide());
        }

        private void AddBtn(string text, int x, Action onClick)
        {
            Button btn = new Button
            {
                Text = text,
                Location = new Point(x, 8),
                Size = new Size(50, 34),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(34, 35, 41),
                ForeColor = Color.White,
                Font = new Font("Segoe UI", 8.5f, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btn.FlatAppearance.BorderColor = Color.FromArgb(50, 51, 61);
            btn.Click += (s, e) => onClick();
            this.Controls.Add(btn);
        }

        public void ShowDock()
        {
            this.Show();
            this.BringToFront();
        }

        public void ToggleDock()
        {
            if (this.Visible) this.Hide();
            else ShowDock();
        }
    }
    #endregion

    #region 全屏透明批注画布与激光笔
    public class ScreenOverlayForm : Form
    {
        private List<Point> strokePoints = new List<Point>();
        private bool isPenActive = false;
        private bool isLaserActive = false;
        private Point laserPos = new Point(-100, -100);

        public ScreenOverlayForm()
        {
            this.FormBorderStyle = FormBorderStyle.None;
            this.WindowState = FormWindowState.Maximized;
            this.TopMost = true;
            this.ShowInTaskbar = false;
            this.DoubleBuffered = true;
            this.BackColor = Color.Magenta;
            this.TransparencyKey = Color.Magenta;

            this.MouseDown += (s, e) =>
            {
                if (isPenActive && e.Button == MouseButtons.Left)
                {
                    strokePoints.Add(e.Location);
                    this.Invalidate();
                }
            };
            this.MouseMove += (s, e) =>
            {
                if (isPenActive && e.Button == MouseButtons.Left)
                {
                    strokePoints.Add(e.Location);
                    this.Invalidate();
                }
                if (isLaserActive)
                {
                    laserPos = e.Location;
                    this.Invalidate();
                }
            };
            this.KeyDown += (s, e) =>
            {
                if (e.KeyCode == Keys.Escape) HideOverlay();
            };
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;

            // 绘制手写笔迹
            if (strokePoints.Count > 1)
            {
                using (Pen pen = new Pen(Color.FromArgb(239, 68, 68), 4))
                {
                    pen.StartCap = LineCap.Round;
                    pen.EndCap = LineCap.Round;
                    for (int i = 1; i < strokePoints.Count; i++)
                    {
                        e.Graphics.DrawLine(pen, strokePoints[i - 1], strokePoints[i]);
                    }
                }
            }

            // 绘制激光指示点
            if (isLaserActive && laserPos.X >= 0)
            {
                using (Brush redGlow = new SolidBrush(Color.FromArgb(140, 239, 68, 68)))
                using (Brush redCore = new SolidBrush(Color.FromArgb(255, 239, 68, 68)))
                {
                    e.Graphics.FillEllipse(redGlow, laserPos.X - 12, laserPos.Y - 12, 24, 24);
                    e.Graphics.FillEllipse(redCore, laserPos.X - 5, laserPos.Y - 5, 10, 10);
                }
            }
        }

        public void ShowOverlay()
        {
            this.Show();
            this.BringToFront();
        }

        public void HideOverlay()
        {
            isPenActive = false;
            isLaserActive = false;
            strokePoints.Clear();
            this.Hide();
        }

        public void TogglePen()
        {
            isPenActive = !isPenActive;
            if (isPenActive) ShowOverlay();
        }

        public void ToggleLaser()
        {
            isLaserActive = !isLaserActive;
            if (isLaserActive) ShowOverlay();
        }
    }
    #endregion
}
