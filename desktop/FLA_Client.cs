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
                        if (line.StartsWith("server_url=", StringComparison.OrdinalIgnoreCase))
                        {
                            string u = line.Substring("server_url=".Length).Trim();
                            if (!string.IsNullOrEmpty(u)) ServerUrl = u;
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
                File.WriteAllText(Path.Combine(dir, "config.ini"), "server_url=" + ServerUrl + Environment.NewLine);
            }
            catch { }
        }

        public static void RegisterProtocol()
        {
            try
            {
                string exePath = Application.ExecutablePath;
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Classes\fla"))
                {
                    key.SetValue("", "URL:FLA Protocol");
                    key.SetValue("URL Protocol", "");
                    using (RegistryKey iconKey = key.CreateSubKey("DefaultIcon"))
                    {
                        iconKey.SetValue("", exePath + ",1");
                    }
                    using (RegistryKey cmdKey = key.CreateSubKey(@"shell\open\command"))
                    {
                        cmdKey.SetValue("", "\"" + exePath + "\" \"%1\"");
                    }
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
                    while (isRunning)
                    {
                        try
                        {
                            HttpListenerContext ctx = httpListener.GetContext();
                            ThreadPool.QueueUserWorkItem(o => HandleHttpRequest(ctx));
                        }
                        catch { if (!isRunning) break; }
                    }
                }
                catch { }
            })
            { IsBackground = true };
            serverThread.Start();
        }

        private static void HandleHttpRequest(HttpListenerContext ctx)
        {
            try
            {
                ctx.Response.Headers.Add("Access-Control-Allow-Origin", "*");
                ctx.Response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
                ctx.Response.Headers.Add("Access-Control-Allow-Headers", "Content-Type");
                if (ctx.Request.HttpMethod == "OPTIONS")
                {
                    ctx.Response.StatusCode = 204;
                    ctx.Response.Close();
                    return;
                }

                string path = ctx.Request.Url.AbsolutePath;
                string respJson = "{\"ok\":true}";

                if (path == "/api/status")
                {
                    respJson = string.Format("{{\"ok\":true,\"version\":\"{0}\",\"status\":\"running\",\"service\":\"fla_desktop\"}}", VERSION);
                }
                else if (path == "/api/open" && ctx.Request.HttpMethod == "POST")
                {
                    using (StreamReader reader = new StreamReader(ctx.Request.InputStream, Encoding.UTF8))
                    {
                        string body = reader.ReadToEnd();
                        string url = ExtractJsonVal(body, "url");
                        string name = ExtractJsonVal(body, "name");
                        string token = ExtractJsonVal(body, "token");
                        if (!string.IsNullOrEmpty(url))
                        {
                            ThreadPool.QueueUserWorkItem(o => LaunchOfficePresentation(url, name, token));
                            respJson = "{\"ok\":true,\"msg\":\"正在调起本地放映并激活工具盒\"}";
                        }
                        else
                        {
                            respJson = "{\"ok\":false,\"msg\":\"缺少 url 参数\"}";
                        }
                    }
                }
                else if (path == "/api/control" && ctx.Request.HttpMethod == "POST")
                {
                    using (StreamReader reader = new StreamReader(ctx.Request.InputStream, Encoding.UTF8))
                    {
                        string body = reader.ReadToEnd();
                        string cmd = ExtractJsonVal(body, "command");
                        ExecuteControlCommand(cmd);
                        respJson = "{\"ok\":true}";
                    }
                }

                byte[] buf = Encoding.UTF8.GetBytes(respJson);
                ctx.Response.ContentType = "application/json; charset=utf-8";
                ctx.Response.ContentLength64 = buf.Length;
                ctx.Response.OutputStream.Write(buf, 0, buf.Length);
                ctx.Response.Close();
            }
            catch { }
        }

        public static void ExecuteControlCommand(string cmd)
        {
            if (string.IsNullOrEmpty(cmd)) return;
            switch (cmd.ToLower())
            {
                case "next": SendKeys.SendWait("{PGDN}"); break;
                case "prev": SendKeys.SendWait("{PGUP}"); break;
                case "first": SendKeys.SendWait("{HOME}"); break;
                case "last": SendKeys.SendWait("{END}"); break;
                case "black": SendKeys.SendWait("b"); break;
                case "white": SendKeys.SendWait("w"); break;
                case "laser":
                    if (OverlayCanvas != null) OverlayCanvas.ToggleLaser();
                    break;
                case "pen":
                    if (OverlayCanvas != null) OverlayCanvas.SetTool(ScreenOverlayForm.ToolType.Pen);
                    break;
                case "eraser":
                    if (OverlayCanvas != null) OverlayCanvas.SetTool(ScreenOverlayForm.ToolType.Eraser);
                    break;
                case "clear":
                    if (OverlayCanvas != null) OverlayCanvas.ClearCurrentPage();
                    break;
                case "dock_toggle":
                    if (FloatingDock != null) FloatingDock.ToggleDock();
                    break;
            }
        }

        private static string ExtractJsonVal(string json, string key)
        {
            try
            {
                string search = "\"" + key + "\":";
                int idx = json.IndexOf(search, StringComparison.OrdinalIgnoreCase);
                if (idx < 0) return "";
                int start = json.IndexOf('"', idx + search.Length);
                if (start < 0) return "";
                int end = json.IndexOf('"', start + 1);
                if (end < 0) return "";
                return json.Substring(start + 1, end - start - 1);
            }
            catch { return ""; }
        }

        private static void ForwardProtocol(string url)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + PORT + "/api/open");
                req.Method = "POST";
                req.ContentType = "application/json";
                byte[] data = Encoding.UTF8.GetBytes(string.Format("{{\"url\":\"{0}\"}}", url));
                req.ContentLength = data.Length;
                using (Stream s = req.GetRequestStream()) s.Write(data, 0, data.Length);
                req.GetResponse().Close();
            }
            catch { }
        }

        public static void HandleProtocolUrl(string url)
        {
            try
            {
                Uri uri = new Uri(url);
                string query = uri.Query;
                string fileUrl = "";
                string fileName = "presentation.pptx";
                string token = "";
                foreach (string part in query.TrimStart('?').Split('&'))
                {
                    string[] kv = part.Split('=');
                    if (kv.Length == 2)
                    {
                        string k = kv[0].ToLower();
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
                string localPath = Path.Combine(CacheDir, fileName);
                using (WebClient client = new WebClient())
                {
                    if (!string.IsNullOrEmpty(token))
                        client.Headers.Add("Authorization", "Bearer " + token);
                    client.DownloadFile(fileUrl, localPath);
                }

                string pptApp = FindPresentationApp();
                ProcessStartInfo psi = new ProcessStartInfo();
                if (!string.IsNullOrEmpty(pptApp) && File.Exists(pptApp))
                {
                    psi.FileName = pptApp;
                    psi.Arguments = "/s \"" + localPath + "\"";
                }
                else
                {
                    psi.FileName = localPath;
                    psi.UseShellExecute = true;
                }
                Process proc = Process.Start(psi);

                Thread.Sleep(1200);
                if (FloatingDock != null)
                {
                    FloatingDock.Invoke(new Action(() => FloatingDock.ShowDock()));
                }
                if (OverlayCanvas != null)
                {
                    OverlayCanvas.Invoke(new Action(() => OverlayCanvas.ShowOverlay()));
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("调起本地放映失败: " + ex.Message, "FLA 提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        public static string FindPresentationApp()
        {
            string[] candidates = new string[]
            {
                @"C:\Program Files\Microsoft Office\root\Office16\POWERPNT.EXE",
                @"C:\Program Files (x86)\Microsoft Office\root\Office16\POWERPNT.EXE",
                @"C:\Program Files\Microsoft Office\Office15\POWERPNT.EXE",
                @"C:\Program Files (x86)\Microsoft Office\Office15\POWERPNT.EXE",
                @"C:\Program Files\Microsoft Office\Office14\POWERPNT.EXE",
                @"C:\Program Files (x86)\Microsoft Office\Office14\POWERPNT.EXE",
                @"C:\Users\" + Environment.UserName + @"\AppData\Local\Kingsoft\WPS Office\ksolaunch.exe",
                @"C:\Program Files (x86)\Kingsoft\WPS Office\ksolaunch.exe"
            };
            foreach (string p in candidates)
            {
                if (File.Exists(p)) return p;
            }
            return "";
        }

        public static void StartSeewoInterceptor()
        {
            seewoThread = new Thread(() =>
            {
                while (isRunning)
                {
                    try
                    {
                        Process[] procs = Process.GetProcessesByName("EasiNote");
                        foreach (Process p in procs)
                        {
                            IntPtr h = p.MainWindowHandle;
                            if (h != IntPtr.Zero)
                            {
                                ShowWindow(h, 0); // SW_HIDE
                            }
                        }
                    }
                    catch { }
                    Thread.Sleep(3000);
                }
            })
            { IsBackground = true };
            seewoThread.Start();
        }

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    }
    #endregion

    #region 云端课件实体类
    public class CloudFileItem
    {
        public int id { get; set; }
        public string name { get; set; }
        public string kind { get; set; }
        public long size { get; set; }
        public int pages { get; set; }
        public string created_at { get; set; }
        public string ext { get; set; }
    }
    #endregion

    #region 主控制台窗口 (MainForm - 纯白黑极简设计)
    public class MainForm : Form
    {
        private Panel navPanel;
        private Panel contentPanel;
        private List<Button> navButtons = new List<Button>();
        private string currentTab = "library";

        public MainForm()
        {
            this.Text = "FLA 智慧课堂桌面助手 · v" + Program.VERSION;
            this.Size = new Size(1000, 680);
            this.MinimumSize = new Size(840, 560);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = Color.FromArgb(255, 255, 255); // 纯白底色
            this.ForeColor = Color.FromArgb(9, 9, 11);       // 曜黑文字
            this.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
            this.DoubleBuffered = true;

            InitLayout();
            SwitchTab("library");
        }

        private void InitLayout()
        {
            // 顶栏 (Header)
            Panel header = new Panel
            {
                Dock = DockStyle.Top,
                Height = 64,
                BackColor = Color.FromArgb(9, 9, 11), // 曜黑顶栏
                Padding = new Padding(24, 0, 24, 0)
            };

            Label title = new Label
            {
                Text = "FLA",
                Font = new Font("Segoe UI", 16f, FontStyle.Bold),
                ForeColor = Color.White,
                AutoSize = true,
                Location = new Point(20, 16)
            };

            Label subTitle = new Label
            {
                Text = "智慧教学桌面助手 · 随页板书联动与希沃压制",
                Font = new Font("Segoe UI", 9f, FontStyle.Regular),
                ForeColor = Color.FromArgb(161, 161, 170),
                AutoSize = true,
                Location = new Point(80, 23)
            };

            Button btnLaunchDock = new Button
            {
                Text = "⚡ 立即唤起悬浮盒",
                Font = new Font("Segoe UI", 9f, FontStyle.Bold),
                Size = new Size(130, 34),
                Location = new Point(this.Width - 280, 15),
                Anchor = AnchorStyles.Top | AnchorStyles.Right,
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.White,
                ForeColor = Color.FromArgb(9, 9, 11),
                Cursor = Cursors.Hand
            };
            btnLaunchDock.FlatAppearance.BorderSize = 0;
            btnLaunchDock.Click += (s, e) =>
            {
                if (Program.FloatingDock != null) Program.FloatingDock.ShowDock();
                if (Program.OverlayCanvas != null) Program.OverlayCanvas.ShowOverlay();
            };

            header.Controls.Add(title);
            header.Controls.Add(subTitle);
            header.Controls.Add(btnLaunchDock);
            this.Controls.Add(header);

            // 侧边导航 (Navigation)
            navPanel = new Panel
            {
                Dock = DockStyle.Left,
                Width = 200,
                BackColor = Color.FromArgb(244, 244, 245), // 浅灰分隔底
                Padding = new Padding(12, 16, 12, 16)
            };

            AddNavButton("课件工作台", "library", 0);
            AddNavButton("手机投屏遥控", "remote", 1);
            AddNavButton("桌面悬浮盒", "dock_cfg", 2);
            AddNavButton("系统与设置", "settings", 3);

            this.Controls.Add(navPanel);

            // 内容区 (Content Container)
            contentPanel = new Panel
            {
                Dock = DockStyle.Fill,
                BackColor = Color.White,
                Padding = new Padding(24)
            };
            this.Controls.Add(contentPanel);
            contentPanel.BringToFront();
        }

        private void AddNavButton(string text, string tabKey, int index)
        {
            Button btn = new Button
            {
                Text = text,
                Tag = tabKey,
                Size = new Size(176, 42),
                Location = new Point(12, 16 + index * 48),
                FlatStyle = FlatStyle.Flat,
                TextAlign = ContentAlignment.MiddleLeft,
                Padding = new Padding(14, 0, 0, 0),
                Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
                Cursor = Cursors.Hand,
                BackColor = Color.Transparent,
                ForeColor = Color.FromArgb(82, 82, 91)
            };
            btn.FlatAppearance.BorderSize = 0;
            btn.Click += (s, e) => SwitchTab(tabKey);
            navButtons.Add(btn);
            navPanel.Controls.Add(btn);
        }

        public void SwitchTab(string tabKey)
        {
            currentTab = tabKey;
            foreach (Button b in navButtons)
            {
                bool active = (string)b.Tag == tabKey;
                b.BackColor = active ? Color.FromArgb(9, 9, 11) : Color.Transparent;
                b.ForeColor = active ? Color.White : Color.FromArgb(82, 82, 91);
            }

            contentPanel.Controls.Clear();
            if (tabKey == "library") InitLibraryTab();
            else if (tabKey == "remote") InitCastingTab();
            else if (tabKey == "dock_cfg") InitDockCfgTab();
            else if (tabKey == "settings") InitSettingsTab();
        }

        private void InitLibraryTab()
        {
            Label h1 = new Label
            {
                Text = "我的课件库 · 一键本地原生放映",
                Font = new Font("Segoe UI", 13f, FontStyle.Bold),
                ForeColor = Color.FromArgb(9, 9, 11),
                AutoSize = true,
                Location = new Point(4, 4)
            };
            Label tip = new Label
            {
                Text = "双击课件或点击「原生放映」调用本地 PowerPoint / WPS 全屏演示，并自动挂接随页板书与悬浮盒。",
                Font = new Font("Segoe UI", 9f, FontStyle.Regular),
                ForeColor = Color.FromArgb(113, 113, 122),
                AutoSize = true,
                Location = new Point(4, 30)
            };

            Button btnRefresh = new Button
            {
                Text = "刷新列表",
                Size = new Size(90, 30),
                Location = new Point(contentPanel.Width - 140, 10),
                Anchor = AnchorStyles.Top | AnchorStyles.Right,
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(244, 244, 245),
                ForeColor = Color.FromArgb(9, 9, 11),
                Cursor = Cursors.Hand
            };
            btnRefresh.FlatAppearance.BorderColor = Color.FromArgb(228, 228, 231);

            ListView lv = new ListView
            {
                Location = new Point(4, 64),
                Size = new Size(contentPanel.Width - 32, contentPanel.Height - 80),
                Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right,
                View = View.Details,
                FullRowSelect = true,
                GridLines = true,
                BackColor = Color.White,
                ForeColor = Color.FromArgb(9, 9, 11),
                Font = new Font("Segoe UI", 9.5f)
            };
            lv.Columns.Add("课件名称", 320);
            lv.Columns.Add("格式类型", 90);
            lv.Columns.Add("规格/页数", 100);
            lv.Columns.Add("文件体积", 100);
            lv.Columns.Add("上传日期", 140);

            Action loadFiles = () =>
            {
                lv.Items.Clear();
                try
                {
                    using (WebClient wc = new WebClient())
                    {
                        wc.Encoding = Encoding.UTF8;
                        string json = wc.DownloadString(Program.ServerUrl + "/api/files");
                        // 简易解析文件项目
                        string[] items = json.Split(new string[] { "},{" }, StringSplitOptions.None);
                        foreach (string item in items)
                        {
                            string name = ExtractJson(item, "name");
                            string kind = ExtractJson(item, "kind");
                            string pages = ExtractJson(item, "pages");
                            string size = ExtractJson(item, "size");
                            string created = ExtractJson(item, "created_at");
                            if (created.Length > 10) created = created.Substring(0, 10);

                            ListViewItem lvi = new ListViewItem(name);
                            lvi.SubItems.Add(kind.ToUpper());
                            lvi.SubItems.Add(pages != "" ? pages + " 页" : "—");
                            lvi.SubItems.Add(size != "" ? FormatSize(long.Parse(size)) : "—");
                            lvi.SubItems.Add(created);
                            lvi.Tag = ExtractJson(item, "id");
                            lv.Items.Add(lvi);
                        }
                    }
                }
                catch { }
            };

            btnRefresh.Click += (s, e) => loadFiles();
            lv.DoubleClick += (s, e) =>
            {
                if (lv.SelectedItems.Count > 0)
                {
                    string fid = (string)lv.SelectedItems[0].Tag;
                    string fname = lv.SelectedItems[0].Text;
                    if (!string.IsNullOrEmpty(fid))
                    {
                        string dlUrl = Program.ServerUrl + "/api/files/" + fid + "/download";
                        Program.LaunchOfficePresentation(dlUrl, fname, "");
                    }
                }
            };

            contentPanel.Controls.Add(h1);
            contentPanel.Controls.Add(tip);
            contentPanel.Controls.Add(btnRefresh);
            contentPanel.Controls.Add(lv);

            ThreadPool.QueueUserWorkItem(o =>
            {
                try { this.Invoke(new Action(loadFiles)); } catch { }
            });
        }

        public void InitCastingTab()
        {
            Label h1 = new Label
            {
                Text = "手机无线投屏与扫码遥控",
                Font = new Font("Segoe UI", 13f, FontStyle.Bold),
                ForeColor = Color.FromArgb(9, 9, 11),
                AutoSize = true,
                Location = new Point(4, 4)
            };
            Label desc = new Label
            {
                Text = "教师使用手机微信或浏览器扫描二维码，即可将手机变成激光笔翻页遥控器与掌上触控板。",
                Font = new Font("Segoe UI", 9f),
                ForeColor = Color.FromArgb(113, 113, 122),
                AutoSize = true,
                Location = new Point(4, 30)
            };

            Panel qrCard = new Panel
            {
                Location = new Point(4, 70),
                Size = new Size(320, 360),
                BackColor = Color.FromArgb(250, 250, 250),
                BorderStyle = BorderStyle.FixedSingle
            };

            Label qrTitle = new Label
            {
                Text = "微信 / 手机扫一扫",
                Font = new Font("Segoe UI", 10.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(9, 9, 11),
                Location = new Point(16, 16),
                AutoSize = true
            };

            PictureBox pbQr = new PictureBox
            {
                Location = new Point(45, 55),
                Size = new Size(220, 220),
                BackColor = Color.White,
                SizeMode = PictureBoxSizeMode.Zoom
            };

            Label qrStatus = new Label
            {
                Text = "遥控通道：127.0.0.1:8307 就绪",
                Font = new Font("Segoe UI", 8.5f),
                ForeColor = Color.FromArgb(113, 113, 122),
                Location = new Point(16, 290),
                AutoSize = true
            };

            qrCard.Controls.Add(qrTitle);
            qrCard.Controls.Add(pbQr);
            qrCard.Controls.Add(qrStatus);

            contentPanel.Controls.Add(h1);
            contentPanel.Controls.Add(desc);
            contentPanel.Controls.Add(qrCard);
        }

        private void InitDockCfgTab()
        {
            Label h1 = new Label
            {
                Text = "教学悬浮盒 (Floating Dock) 设定",
                Font = new Font("Segoe UI", 13f, FontStyle.Bold),
                ForeColor = Color.FromArgb(9, 9, 11),
                AutoSize = true,
                Location = new Point(4, 4)
            };
            Label tip = new Label
            {
                Text = "定制悬浮盒工具项、默认画笔粗细、边角吸附贴边行为与快捷热键。",
                Font = new Font("Segoe UI", 9f),
                ForeColor = Color.FromArgb(113, 113, 122),
                AutoSize = true,
                Location = new Point(4, 30)
            };

            Button btnTestDock = new Button
            {
                Text = "展示桌面悬浮盒",
                Size = new Size(140, 36),
                Location = new Point(4, 80),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(9, 9, 11),
                ForeColor = Color.White,
                Font = new Font("Segoe UI", 9f, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btnTestDock.FlatAppearance.BorderSize = 0;
            btnTestDock.Click += (s, e) =>
            {
                if (Program.FloatingDock != null) Program.FloatingDock.ShowDock();
                if (Program.OverlayCanvas != null) Program.OverlayCanvas.ShowOverlay();
            };

            CheckBox cbAutoDock = new CheckBox
            {
                Text = "拖拽至屏幕边缘时自动收起为极简标签",
                Checked = true,
                Location = new Point(4, 136),
                AutoSize = true
            };
            CheckBox cbSeewo = new CheckBox
            {
                Text = "放映时智能抑制希沃白板5侧边栏",
                Checked = true,
                Location = new Point(4, 168),
                AutoSize = true
            };

            contentPanel.Controls.Add(h1);
            contentPanel.Controls.Add(tip);
            contentPanel.Controls.Add(btnTestDock);
            contentPanel.Controls.Add(cbAutoDock);
            contentPanel.Controls.Add(cbSeewo);
        }

        private void InitSettingsTab()
        {
            Label h1 = new Label
            {
                Text = "系统连接与服务配置",
                Font = new Font("Segoe UI", 13f, FontStyle.Bold),
                ForeColor = Color.FromArgb(9, 9, 11),
                AutoSize = true,
                Location = new Point(4, 4)
            };

            Label lblUrl = new Label { Text = "FLA 云端服务地址:", Location = new Point(4, 60), AutoSize = true };
            TextBox txtUrl = new TextBox
            {
                Text = Program.ServerUrl,
                Location = new Point(4, 84),
                Size = new Size(340, 26),
                Font = new Font("Segoe UI", 9.5f)
            };
            Button btnSave = new Button
            {
                Text = "保存配置",
                Location = new Point(4, 120),
                Size = new Size(100, 32),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(9, 9, 11),
                ForeColor = Color.White,
                Cursor = Cursors.Hand
            };
            btnSave.FlatAppearance.BorderSize = 0;
            btnSave.Click += (s, e) =>
            {
                Program.ServerUrl = txtUrl.Text.Trim();
                Program.SaveConfig();
                MessageBox.Show("配置已保存！", "FLA", MessageBoxButtons.OK, MessageBoxIcon.Information);
            };

            contentPanel.Controls.Add(h1);
            contentPanel.Controls.Add(lblUrl);
            contentPanel.Controls.Add(txtUrl);
            contentPanel.Controls.Add(btnSave);
        }

        private string ExtractJson(string json, string key)
        {
            try
            {
                string search = "\"" + key + "\":";
                int idx = json.IndexOf(search);
                if (idx < 0) return "";
                int start = idx + search.Length;
                if (json[start] == '"')
                {
                    start++;
                    int end = json.IndexOf('"', start);
                    return end > start ? json.Substring(start, end - start) : "";
                }
                else
                {
                    int end = json.IndexOfAny(new char[] { ',', '}', ']' }, start);
                    return end > start ? json.Substring(start, end - start).Trim() : "";
                }
            }
            catch { return ""; }
        }

        private string FormatSize(long b)
        {
            if (b < 1024) return b + " B";
            if (b < 1024 * 1024) return (b / 1024.0).ToString("0.#") + " KB";
            return (b / (1024.0 * 1024.0)).ToString("0.#") + " MB";
        }
    }
    #endregion

    #region 全新现代化桌面悬浮工具盒 (FloatingDockForm - 极简白黑胶囊)
    public class FloatingDockForm : Form
    {
        private bool isDragging = false;
        private Point dragCursorPoint;
        private Point dragFormPoint;
        private bool isCollapsed = false;
        private int originalWidth = 560;
        private int originalHeight = 56;
        private Panel palettePanel;

        public FloatingDockForm()
        {
            this.FormBorderStyle = FormBorderStyle.None;
            this.StartPosition = FormStartPosition.Manual;
            this.Size = new Size(580, 56);
            this.Location = new Point(Screen.PrimaryScreen.WorkingArea.Width / 2 - 290, Screen.PrimaryScreen.WorkingArea.Height - 88);
            this.TopMost = true;
            this.ShowInTaskbar = false;
            this.BackColor = Color.FromArgb(9, 9, 11); // 纯曜黑底色
            this.ForeColor = Color.White;
            this.DoubleBuffered = true;

            InitDockUI();
            MakeRoundedCorners(28);

            this.MouseDown += OnMouseDownDrag;
            this.MouseMove += OnMouseMoveDrag;
            this.MouseUp += (s, e) => { isDragging = false; SnapToScreenEdge(); };
        }

        private void MakeRoundedCorners(int radius)
        {
            try
            {
                GraphicsPath path = new GraphicsPath();
                int d = radius * 2;
                Rectangle r = new Rectangle(0, 0, this.Width, this.Height);
                path.AddArc(r.X, r.Y, d, d, 180, 90);
                path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
                path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
                path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
                path.CloseFigure();
                this.Region = new Region(path);
            }
            catch { }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;

            // 绘制高级高光细边框
            using (Pen borderPen = new Pen(Color.FromArgb(39, 39, 42), 1.5f))
            {
                e.Graphics.DrawPath(borderPen, GetCapsulePath(new Rectangle(0, 0, this.Width - 1, this.Height - 1), 27));
            }

            // 绘制拖拽手柄 (Grip dots)
            if (!isCollapsed)
            {
                using (Brush b = new SolidBrush(Color.FromArgb(82, 82, 91)))
                {
                    e.Graphics.FillEllipse(b, 12, 22, 3, 3);
                    e.Graphics.FillEllipse(b, 12, 28, 3, 3);
                    e.Graphics.FillEllipse(b, 12, 34, 3, 3);
                    e.Graphics.FillEllipse(b, 17, 22, 3, 3);
                    e.Graphics.FillEllipse(b, 17, 28, 3, 3);
                    e.Graphics.FillEllipse(b, 17, 34, 3, 3);
                }
            }
        }

        private GraphicsPath GetCapsulePath(Rectangle r, int radius)
        {
            GraphicsPath p = new GraphicsPath();
            int d = radius * 2;
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        private void InitDockUI()
        {
            this.Controls.Clear();
            int x = 28;

            // 1. 穿透光标 (Cursor Mode)
            AddDockItem("👆 选择", x, 46, () =>
            {
                if (Program.OverlayCanvas != null) Program.OverlayCanvas.SetTool(ScreenOverlayForm.ToolType.Cursor);
            });
            x += 48;

            // 2. 激光笔 (Laser Pointer)
            AddDockItem("🔴 激光", x, 46, () =>
            {
                if (Program.OverlayCanvas != null) Program.OverlayCanvas.ToggleLaser();
            });
            x += 48;

            // 3. 随页批注画笔 (Pen)
            AddDockItem("✏️ 画笔", x, 46, () =>
            {
                if (Program.OverlayCanvas != null)
                {
                    Program.OverlayCanvas.SetTool(ScreenOverlayForm.ToolType.Pen);
                    TogglePalette();
                }
            });
            x += 48;

            // 4. 荧光笔 (Highlighter)
            AddDockItem("🖍 荧光", x, 46, () =>
            {
                if (Program.OverlayCanvas != null) Program.OverlayCanvas.SetTool(ScreenOverlayForm.ToolType.Highlighter);
            });
            x += 48;

            // 5. 智能橡皮 (Eraser)
            AddDockItem("🧹 橡皮", x, 46, () =>
            {
                if (Program.OverlayCanvas != null) Program.OverlayCanvas.SetTool(ScreenOverlayForm.ToolType.Eraser);
            });
            x += 48;

            // 6. 清屏 (Clear Page)
            AddDockItem("🗑 清屏", x, 46, () =>
            {
                if (Program.OverlayCanvas != null) Program.OverlayCanvas.ClearCurrentPage();
            });
            x += 52;

            // 分隔线
            Label sep1 = new Label { Text = "|", ForeColor = Color.FromArgb(63, 63, 70), Location = new Point(x, 18), AutoSize = true };
            this.Controls.Add(sep1);
            x += 14;

            // 7. 幻灯片步进控制 (Slide Navigation)
            AddDockItem("‹", x, 28, () =>
            {
                SendKeys.SendWait("{PGUP}");
                if (Program.OverlayCanvas != null) Program.OverlayCanvas.PrevSlide();
            });
            x += 30;

            AddDockItem("›", x, 28, () =>
            {
                SendKeys.SendWait("{PGDN}");
                if (Program.OverlayCanvas != null) Program.OverlayCanvas.NextSlide();
            });
            x += 32;

            // 8. 全屏白板 (Whiteboard)
            AddDockItem("📄 白板", x, 46, () =>
            {
                if (Program.OverlayCanvas != null) Program.OverlayCanvas.ToggleWhiteboard();
            });
            x += 48;

            // 9. 教学工具箱 (Timer / Random Picker)
            AddDockItem("⏱ 工具", x, 46, () => ShowToolsMenu());
            x += 48;

            // 10. 收起 / 折叠 (Collapse)
            AddDockItem("✕", x, 30, () => CollapseDock());
        }

        private void AddDockItem(string label, int x, int width, Action onClick)
        {
            Button btn = new Button
            {
                Text = label,
                Location = new Point(x, 10),
                Size = new Size(width, 36),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(24, 24, 27),
                ForeColor = Color.White,
                Font = new Font("Segoe UI", 8.5f, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btn.FlatAppearance.BorderSize = 0;
            btn.FlatAppearance.MouseOverBackColor = Color.FromArgb(39, 39, 42);
            btn.Click += (s, e) => onClick();
            this.Controls.Add(btn);
        }

        private void TogglePalette()
        {
            if (palettePanel != null && palettePanel.Visible)
            {
                palettePanel.Hide();
                return;
            }
            if (palettePanel == null)
            {
                palettePanel = new Panel
                {
                    Size = new Size(160, 40),
                    BackColor = Color.FromArgb(9, 9, 11),
                    BorderStyle = BorderStyle.FixedSingle
                };
                AddColorBtn(palettePanel, 6, Color.White, 3);
                AddColorBtn(palettePanel, 36, Color.FromArgb(239, 68, 68), 3);
                AddColorBtn(palettePanel, 66, Color.FromArgb(250, 204, 21), 4);
                AddColorBtn(palettePanel, 96, Color.FromArgb(59, 130, 246), 3);
                AddColorBtn(palettePanel, 126, Color.FromArgb(16, 185, 129), 3);
            }
            palettePanel.Location = new Point(this.Left + 120, this.Top - 46);
            palettePanel.BringToFront();
            palettePanel.Show();
        }

        private void AddColorBtn(Panel p, int x, Color c, int width)
        {
            Button b = new Button
            {
                Location = new Point(x, 6),
                Size = new Size(26, 26),
                BackColor = c,
                FlatStyle = FlatStyle.Flat,
                Cursor = Cursors.Hand
            };
            b.FlatAppearance.BorderSize = 1;
            b.FlatAppearance.BorderColor = Color.FromArgb(63, 63, 70);
            b.Click += (s, e) =>
            {
                if (Program.OverlayCanvas != null)
                {
                    Program.OverlayCanvas.CurrentPenColor = c;
                    Program.OverlayCanvas.CurrentPenWidth = width;
                }
                p.Hide();
            };
            p.Controls.Add(b);
        }

        private void ShowToolsMenu()
        {
            ContextMenu cm = new ContextMenu();
            cm.MenuItems.Add("课堂倒计时 (5分钟)", (s, e) => StartClassTimer(300));
            cm.MenuItems.Add("课堂秒表计时", (s, e) => StartStopwatch());
            cm.MenuItems.Add("黑板 / 纯黑幕布 (B)", (s, e) => SendKeys.SendWait("b"));
            cm.MenuItems.Add("白板 / 纯白幕布 (W)", (s, e) => SendKeys.SendWait("w"));
            cm.MenuItems.Add("-");
            cm.MenuItems.Add("返回主控制台", (s, e) =>
            {
                if (Program.MainWindow != null)
                {
                    Program.MainWindow.Show();
                    Program.MainWindow.BringToFront();
                }
            });
            cm.Show(this, new Point(380, 20));
        }

        private void StartClassTimer(int seconds)
        {
            Form timerForm = new Form
            {
                FormBorderStyle = FormBorderStyle.None,
                StartPosition = FormStartPosition.CenterScreen,
                Size = new Size(260, 100),
                BackColor = Color.FromArgb(9, 9, 11),
                TopMost = true
            };
            Label lbl = new Label
            {
                Text = "05:00",
                Font = new Font("Segoe UI", 32f, FontStyle.Bold),
                ForeColor = Color.White,
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleCenter
            };
            timerForm.Controls.Add(lbl);

            int remain = seconds;
            System.Windows.Forms.Timer t = new System.Windows.Forms.Timer { Interval = 1000 };
            t.Tick += (s, e) =>
            {
                remain--;
                int m = remain / 60;
                int sec = remain % 60;
                lbl.Text = string.Format("{0:00}:{1:00}", m, sec);
                if (remain <= 0)
                {
                    t.Stop();
                    lbl.ForeColor = Color.FromArgb(239, 68, 68);
                }
            };
            lbl.DoubleClick += (s, e) => { t.Stop(); timerForm.Close(); };
            t.Start();
            timerForm.Show();
        }

        private void StartStopwatch()
        {
            StartClassTimer(0);
        }

        private void CollapseDock()
        {
            isCollapsed = true;
            this.Controls.Clear();
            this.Size = new Size(54, 54);
            MakeRoundedCorners(27);

            Button btnExpand = new Button
            {
                Text = "FLA",
                Dock = DockStyle.Fill,
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(9, 9, 11),
                ForeColor = Color.White,
                Font = new Font("Segoe UI", 9f, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btnExpand.FlatAppearance.BorderSize = 0;
            btnExpand.Click += (s, e) => ExpandDock();
            this.Controls.Add(btnExpand);
        }

        public void ExpandDock()
        {
            isCollapsed = false;
            this.Size = new Size(580, 56);
            MakeRoundedCorners(28);
            InitDockUI();
        }

        private void SnapToScreenEdge()
        {
            Screen s = Screen.FromControl(this);
            int thresh = 40;
            if (this.Left < s.WorkingArea.Left + thresh) this.Left = s.WorkingArea.Left + 8;
            if (this.Right > s.WorkingArea.Right - thresh) this.Left = s.WorkingArea.Right - this.Width - 8;
            if (this.Bottom > s.WorkingArea.Bottom - thresh) this.Top = s.WorkingArea.Bottom - this.Height - 8;
            if (this.Top < s.WorkingArea.Top + thresh) this.Top = s.WorkingArea.Top + 8;
        }

        private void OnMouseDownDrag(object s, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left)
            {
                isDragging = true;
                dragCursorPoint = Cursor.Position;
                dragFormPoint = this.Location;
            }
        }

        private void OnMouseMoveDrag(object s, MouseEventArgs e)
        {
            if (isDragging)
            {
                Point diff = Point.Subtract(Cursor.Position, new Size(dragCursorPoint));
                this.Location = Point.Add(dragFormPoint, new Size(diff));
            }
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

    #region 全屏批注与随页板书画布 (ScreenOverlayForm - 极简白黑系统)
    public class ScreenOverlayForm : Form
    {
        public enum ToolType { Cursor, Laser, Pen, Highlighter, Eraser }

        public ToolType CurrentTool = ToolType.Cursor;
        public Color CurrentPenColor = Color.FromArgb(239, 68, 68);
        public int CurrentPenWidth = 3;
        public int CurrentSlideIndex = 1;

        public class Stroke
        {
            public ToolType Tool;
            public Color StrokeColor;
            public int Width;
            public List<Point> Points = new List<Point>();
        }

        private Dictionary<int, List<Stroke>> slideStrokes = new Dictionary<int, List<Stroke>>();
        private Stroke activeStroke = null;
        private Point laserPos = new Point(-100, -100);
        private bool isWhiteboardMode = false;

        public ScreenOverlayForm()
        {
            this.FormBorderStyle = FormBorderStyle.None;
            this.WindowState = FormWindowState.Maximized;
            this.TopMost = true;
            this.ShowInTaskbar = false;
            this.DoubleBuffered = true;
            this.BackColor = Color.Magenta;
            this.TransparencyKey = Color.Magenta;

            this.MouseDown += OnMouseDown;
            this.MouseMove += OnMouseMove;
            this.MouseUp += OnMouseUp;
            this.KeyDown += OnKeyDown;

            SetPassThrough(true);
        }

        public void SetTool(ToolType tool)
        {
            CurrentTool = tool;
            SetPassThrough(tool == ToolType.Cursor);
            this.Invalidate();
        }

        public void ToggleLaser()
        {
            if (CurrentTool == ToolType.Laser) SetTool(ToolType.Cursor);
            else SetTool(ToolType.Laser);
        }

        public void ToggleWhiteboard()
        {
            isWhiteboardMode = !isWhiteboardMode;
            if (isWhiteboardMode)
            {
                this.TransparencyKey = Color.Empty;
                this.BackColor = Color.FromArgb(18, 18, 20); // 纯黑板底色
                SetPassThrough(false);
            }
            else
            {
                this.BackColor = Color.Magenta;
                this.TransparencyKey = Color.Magenta;
                SetPassThrough(CurrentTool == ToolType.Cursor);
            }
            this.Invalidate();
        }

        public void NextSlide()
        {
            CurrentSlideIndex++;
            this.Invalidate();
        }

        public void PrevSlide()
        {
            if (CurrentSlideIndex > 1) CurrentSlideIndex--;
            this.Invalidate();
        }

        public void ClearCurrentPage()
        {
            if (slideStrokes.ContainsKey(CurrentSlideIndex))
            {
                slideStrokes[CurrentSlideIndex].Clear();
                this.Invalidate();
            }
        }

        private void SetPassThrough(bool passThrough)
        {
            try
            {
                int exStyle = GetWindowLong(this.Handle, -20); // GWL_EXSTYLE
                if (passThrough)
                    SetWindowLong(this.Handle, -20, exStyle | 0x20 | 0x80000); // WS_EX_TRANSPARENT | WS_EX_LAYERED
                else
                    SetWindowLong(this.Handle, -20, (exStyle & ~0x20) | 0x80000);
            }
            catch { }
        }

        private void OnMouseDown(object s, MouseEventArgs e)
        {
            if (CurrentTool == ToolType.Pen || CurrentTool == ToolType.Highlighter)
            {
                if (!slideStrokes.ContainsKey(CurrentSlideIndex))
                    slideStrokes[CurrentSlideIndex] = new List<Stroke>();

                activeStroke = new Stroke
                {
                    Tool = CurrentTool,
                    StrokeColor = CurrentTool == ToolType.Highlighter ? Color.FromArgb(100, 250, 204, 21) : CurrentPenColor,
                    Width = CurrentTool == ToolType.Highlighter ? 18 : CurrentPenWidth
                };
                activeStroke.Points.Add(e.Location);
                slideStrokes[CurrentSlideIndex].Add(activeStroke);
                this.Invalidate();
            }
            else if (CurrentTool == ToolType.Eraser)
            {
                EraseAt(e.Location);
            }
        }

        private void OnMouseMove(object s, MouseEventArgs e)
        {
            if (CurrentTool == ToolType.Laser)
            {
                laserPos = e.Location;
                this.Invalidate();
            }
            else if ((CurrentTool == ToolType.Pen || CurrentTool == ToolType.Highlighter) && activeStroke != null)
            {
                activeStroke.Points.Add(e.Location);
                this.Invalidate();
            }
            else if (CurrentTool == ToolType.Eraser && e.Button == MouseButtons.Left)
            {
                EraseAt(e.Location);
            }
        }

        private void OnMouseUp(object s, MouseEventArgs e)
        {
            activeStroke = null;
        }

        private void EraseAt(Point pt)
        {
            if (!slideStrokes.ContainsKey(CurrentSlideIndex)) return;
            List<Stroke> list = slideStrokes[CurrentSlideIndex];
            int r2 = 18 * 18;
            for (int i = list.Count - 1; i >= 0; i--)
            {
                bool hit = false;
                foreach (Point p in list[i].Points)
                {
                    int dx = p.X - pt.X;
                    int dy = p.Y - pt.Y;
                    if (dx * dx + dy * dy <= r2) { hit = true; break; }
                }
                if (hit) list.RemoveAt(i);
            }
            this.Invalidate();
        }

        private void OnKeyDown(object s, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Escape)
            {
                SetTool(ToolType.Cursor);
            }
            else if (e.Control && e.KeyCode == Keys.Z)
            {
                if (slideStrokes.ContainsKey(CurrentSlideIndex) && slideStrokes[CurrentSlideIndex].Count > 0)
                {
                    slideStrokes[CurrentSlideIndex].RemoveAt(slideStrokes[CurrentSlideIndex].Count - 1);
                    this.Invalidate();
                }
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;

            // 渲染当前幻灯片页面的所有笔迹
            if (slideStrokes.ContainsKey(CurrentSlideIndex))
            {
                foreach (Stroke s in slideStrokes[CurrentSlideIndex])
                {
                    if (s.Points.Count > 1)
                    {
                        using (Pen pen = new Pen(s.StrokeColor, s.Width))
                        {
                            pen.StartCap = LineCap.Round;
                            pen.EndCap = LineCap.Round;
                            pen.LineJoin = LineJoin.Round;
                            e.Graphics.DrawLines(pen, s.Points.ToArray());
                        }
                    }
                }
            }

            // 渲染激光指示笔光晕
            if (CurrentTool == ToolType.Laser && laserPos.X >= 0)
            {
                using (Brush glow = new SolidBrush(Color.FromArgb(120, 239, 68, 68)))
                using (Brush core = new SolidBrush(Color.FromArgb(255, 239, 68, 68)))
                {
                    e.Graphics.FillEllipse(glow, laserPos.X - 14, laserPos.Y - 14, 28, 28);
                    e.Graphics.FillEllipse(core, laserPos.X - 6, laserPos.Y - 6, 12, 12);
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
            this.Hide();
        }

        [DllImport("user32.dll")]
        private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll")]
        private static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    }
    #endregion
}
