// FLA 手机端 (iOS): WKWebView 外壳 + 原生扫码 + ReplayKit 整屏投屏 (广播扩展 FLABroadcast.appex)
// 与安卓版共用 home.html / 线路上的 cast.html, JS 接口同为 window.FLA.*
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <AVFoundation/AVFoundation.h>
#import <ReplayKit/ReplayKit.h>

static NSString *const kVersion = @"1.0.0";
static NSString *const kGroup = @"group.top.clrv.fla";
static NSString *const kExt = @"top.clrv.fla.app.broadcast";

static NSString *JSQuote(NSString *s) {
    NSData *d = [NSJSONSerialization dataWithJSONObject:@[s ?: @""] options:0 error:nil];
    NSString *a = [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding];
    return [a substringWithRange:NSMakeRange(1, a.length - 2)];
}

// ================================================================== 扫码
@interface ScanVC : UIViewController <AVCaptureMetadataOutputObjectsDelegate>
@property (nonatomic, strong) AVCaptureSession *session;
@property (nonatomic, copy) void (^done)(NSString *text);
@end

@implementation ScanVC
- (void)viewDidLoad {
    [super viewDidLoad];
    self.view.backgroundColor = UIColor.blackColor;
    self.session = [AVCaptureSession new];
    AVCaptureDevice *dev = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
    AVCaptureDeviceInput *input = dev ? [AVCaptureDeviceInput deviceInputWithDevice:dev error:nil] : nil;
    if (input && [self.session canAddInput:input]) [self.session addInput:input];
    AVCaptureMetadataOutput *out = [AVCaptureMetadataOutput new];
    if ([self.session canAddOutput:out]) {
        [self.session addOutput:out];
        [out setMetadataObjectsDelegate:self queue:dispatch_get_main_queue()];
        if ([out.availableMetadataObjectTypes containsObject:AVMetadataObjectTypeQRCode])
            out.metadataObjectTypes = @[AVMetadataObjectTypeQRCode];
    }
    AVCaptureVideoPreviewLayer *pl = [AVCaptureVideoPreviewLayer layerWithSession:self.session];
    pl.videoGravity = AVLayerVideoGravityResizeAspectFill;
    pl.frame = self.view.bounds;
    [self.view.layer addSublayer:pl];

    CGSize sz = self.view.bounds.size;
    CGFloat w = MIN(sz.width, sz.height) * 0.68;
    UIView *box = [[UIView alloc] initWithFrame:CGRectMake((sz.width - w) / 2, (sz.height - w) / 2, w, w)];
    box.layer.borderColor = UIColor.whiteColor.CGColor;
    box.layer.borderWidth = 3;
    box.layer.cornerRadius = 24;
    [self.view addSubview:box];

    UILabel *tip = [UILabel new];
    tip.text = input ? @"将电脑上的二维码放入框内" : @"无法打开相机：请在 设置 → FLA 中允许使用相机";
    tip.textColor = UIColor.whiteColor;
    tip.numberOfLines = 2;
    tip.textAlignment = NSTextAlignmentCenter;
    tip.frame = CGRectMake(20, CGRectGetMaxY(box.frame) + 20, sz.width - 40, 48);
    [self.view addSubview:tip];

    UIButton *x = [UIButton buttonWithType:UIButtonTypeSystem];
    [x setTitle:@"取消" forState:UIControlStateNormal];
    x.titleLabel.font = [UIFont systemFontOfSize:18 weight:UIFontWeightSemibold];
    [x setTitleColor:UIColor.whiteColor forState:UIControlStateNormal];
    x.backgroundColor = [UIColor colorWithWhite:1 alpha:0.18];
    x.layer.cornerRadius = 26;
    x.frame = CGRectMake((sz.width - 120) / 2, sz.height - 120, 120, 52);
    [x addTarget:self action:@selector(cancel) forControlEvents:UIControlEventTouchUpInside];
    [self.view addSubview:x];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{ [self.session startRunning]; });
}
- (void)cancel {
    [self.session stopRunning];
    [self dismissViewControllerAnimated:YES completion:nil];
}
- (void)captureOutput:(AVCaptureOutput *)o didOutputMetadataObjects:(NSArray *)objs fromConnection:(AVCaptureConnection *)c {
    for (AVMetadataObject *m in objs) {
        if (![m isKindOfClass:AVMetadataMachineReadableCodeObject.class]) continue;
        NSString *s = ((AVMetadataMachineReadableCodeObject *)m).stringValue;
        if (!s.length) continue;
        [self.session stopRunning];
        [[[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleMedium] impactOccurred];
        void (^d)(NSString *) = self.done;
        [self dismissViewControllerAnimated:YES completion:^{ if (d) d(s); }];
        return;
    }
}
@end

// ================================================================== 主界面
@interface MainVC : UIViewController <WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate>
@property (nonatomic, strong) WKWebView *web;
@property (nonatomic, strong) UIView *picker;
@property (nonatomic, copy) NSString *status;
@end

@implementation MainVC
- (UIStatusBarStyle)preferredStatusBarStyle { return UIStatusBarStyleLightContent; }

- (NSURL *)homeURL { return [[NSBundle mainBundle] URLForResource:@"home" withExtension:@"html" subdirectory:@"www"]; }

- (void)viewDidLoad {
    [super viewDidLoad];
    self.view.backgroundColor = [UIColor colorWithRed:0.043 green:0.043 blue:0.047 alpha:1];
    WKWebViewConfiguration *cfg = [WKWebViewConfiguration new];
    cfg.allowsInlineMediaPlayback = YES;
    cfg.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeNone;
    cfg.applicationNameForUserAgent = [NSString stringWithFormat:@"Mobile/15E148 Safari/604.1 FLA-App/%@ FLA-iOS", kVersion];
    WKUserContentController *uc = [WKUserContentController new];
    [uc addScriptMessageHandler:self name:@"fla"];
    NSString *shim = [NSString stringWithFormat:@
        "(function(){if(window.FLA)return;"
        "var p=function(m,a){window.webkit.messageHandlers.fla.postMessage({m:m,a:a||[]});};"
        "window.FLA={ios:true,version:function(){return '%@';},"
        "pair:function(s,c){p('pair',[s,c]);},"
        "startScreen:function(s,c,v){p('startScreen',[s,c,v]);},"
        "stopScreen:function(){p('stopScreen');},"
        "home:function(){p('home');},vibrate:function(){p('vibrate');},"
        "scanNative:function(){p('scan');}};})();", kVersion];
    [uc addUserScript:[[WKUserScript alloc] initWithSource:shim injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
    cfg.userContentController = uc;

    self.web = [[WKWebView alloc] initWithFrame:self.view.bounds configuration:cfg];
    self.web.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    self.web.opaque = NO;
    self.web.backgroundColor = self.view.backgroundColor;
    self.web.scrollView.backgroundColor = self.view.backgroundColor;
    self.web.navigationDelegate = self;
    self.web.UIDelegate = self;
    self.web.allowsBackForwardNavigationGestures = NO;
    [self.view addSubview:self.web];
    [self goHome];

    // 系统广播选择器 (隐藏, 由代码触发其按钮)
    if (@available(iOS 12.0, *)) {
        RPSystemBroadcastPickerView *pk = [[RPSystemBroadcastPickerView alloc] initWithFrame:CGRectMake(-200, -200, 60, 60)];
        pk.preferredExtension = kExt;
        pk.showsMicrophoneButton = NO;
        [self.view addSubview:pk];
        self.picker = pk;
    }
    [NSTimer scheduledTimerWithTimeInterval:1.5 repeats:YES block:^(NSTimer *t) { [self pollBroadcast]; }];
}

- (void)goHome {
    NSURL *u = [self homeURL];
    [self.web loadFileURL:u allowingReadAccessToURL:u.URLByDeletingLastPathComponent];
}

- (void)js:(NSString *)code { dispatch_async(dispatch_get_main_queue(), ^{ [self.web evaluateJavaScript:code completionHandler:nil]; }); }

- (void)pushStatus {
    NSUserDefaults *g = [[NSUserDefaults alloc] initWithSuiteName:kGroup];
    double alive = [g doubleForKey:@"alive"];
    BOOL on = alive > 0 && [NSDate date].timeIntervalSince1970 - alive < 4;
    NSString *s = self.status ?: @"整个 iPhone 屏幕实时投到电脑（PPT、相册、任何 App）";
    if (on) s = [g stringForKey:@"state"] ?: @"正在整屏投屏";
    [self js:[NSString stringWithFormat:@"window.flaStatus&&window.flaStatus(%@,%@)", JSQuote(s), on ? @"true" : @"false"]];
}
- (void)pollBroadcast { [self pushStatus]; }

- (BOOL)trusted {
    NSURL *u = self.web.URL;
    if (u.isFileURL) return YES;
    NSString *h = u.host ?: @"";
    return [h hasSuffix:@"clrv.top"] || [h hasSuffix:@"fyx.best"] || [h hasPrefix:@"192.168."] || [h hasPrefix:@"10."] || [h hasPrefix:@"172."];
}

- (void)userContentController:(WKUserContentController *)uc didReceiveScriptMessage:(WKScriptMessage *)msg {
    if (![msg.body isKindOfClass:NSDictionary.class]) return;
    NSString *m = msg.body[@"m"];
    NSArray *a = msg.body[@"a"];
    if ([m isEqualToString:@"pair"] && a.count >= 2) [self pair:a[0] code:a[1]];
    else if ([m isEqualToString:@"home"]) [self goHome];
    else if ([m isEqualToString:@"vibrate"]) [[[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleLight] impactOccurred];
    else if ([m isEqualToString:@"scan"]) [self scan];
    else if ([m isEqualToString:@"startScreen"] && a.count >= 3 && [self trusted]) [self startScreen:a[0] code:a[1] server:a[2]];
    else if ([m isEqualToString:@"stopScreen"]) {
        self.status = @"请点屏幕左上角红色计时条 → 停止，或在控制中心停止录屏";
        [self tapPicker];
    }
}

- (void)scan {
    ScanVC *v = [ScanVC new];
    v.modalPresentationStyle = UIModalPresentationFullScreen;
    __weak MainVC *ws = self;
    v.done = ^(NSString *t) { [ws js:[NSString stringWithFormat:@"window.onScan&&window.onScan(%@)", JSQuote(t)]]; };
    [self presentViewController:v animated:YES completion:nil];
}

- (void)get:(NSString *)url done:(void (^)(NSDictionary *d, NSInteger code))done {
    NSMutableURLRequest *r = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:url]];
    r.timeoutInterval = 10;
    [[[NSURLSession sharedSession] dataTaskWithRequest:r completionHandler:^(NSData *data, NSURLResponse *resp, NSError *err) {
        NSInteger code = [(NSHTTPURLResponse *)resp statusCode];
        NSDictionary *d = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
        dispatch_async(dispatch_get_main_queue(), ^{ done([d isKindOfClass:NSDictionary.class] ? d : nil, err ? -1 : code); });
    }] resume];
}

- (void)pair:(NSString *)srv code:(NSString *)c {
    NSString *enc = [c stringByAddingPercentEncodingWithAllowedCharacters:NSCharacterSet.URLPathAllowedCharacterSet];
    [self get:[NSString stringWithFormat:@"%@/api/remote/pair/%@", srv, enc] done:^(NSDictionary *d, NSInteger code) {
        if (code == 200 && d[@"session_id"]) {
            [self js:[NSString stringWithFormat:@"onPair(true,%@,%@,%@)", JSQuote(srv), JSQuote(d[@"session_id"]), JSQuote(c)]];
        } else {
            NSString *e = code >= 400 && code < 500 ? @"配对码无效，请确认电脑已打开「手机」面板" : @"网络不通，请检查网络或切换线路";
            [self js:[NSString stringWithFormat:@"onPair(false,'','','',%@)", JSQuote(e)]];
        }
    }];
}

/** 登记会话 (App Group + 服务器按设备 ID), 然后弹出系统「开始直播」面板 */
- (void)startScreen:(NSString *)sid code:(NSString *)code server:(NSString *)srv {
    NSUserDefaults *g = [[NSUserDefaults alloc] initWithSuiteName:kGroup];
    [g setObject:sid forKey:@"sid"];
    [g setObject:code forKey:@"code"];
    [g setObject:srv forKey:@"server"];
    [g synchronize];
    NSString *vid = UIDevice.currentDevice.identifierForVendor.UUIDString ?: @"";
    NSMutableURLRequest *r = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:[srv stringByAppendingString:@"/api/remote/ios/register"]]];
    r.HTTPMethod = @"POST";
    [r setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
    r.HTTPBody = [NSJSONSerialization dataWithJSONObject:@{@"vid": vid, @"sid": sid, @"code": code} options:0 error:nil];
    self.status = @"在弹出的面板中选择「FLA 投屏」→ 开始直播";
    [self pushStatus];
    [[[NSURLSession sharedSession] dataTaskWithRequest:r completionHandler:^(NSData *d, NSURLResponse *resp, NSError *e) {
        dispatch_async(dispatch_get_main_queue(), ^{ [self tapPicker]; });
    }] resume];
}

- (void)tapPicker {
    for (UIView *v in self.picker.subviews) {
        if ([v isKindOfClass:UIButton.class]) { [(UIButton *)v sendActionsForControlEvents:UIControlEventTouchUpInside]; return; }
    }
}

// ---- WebView
- (void)webView:(WKWebView *)w decidePolicyForNavigationAction:(WKNavigationAction *)a decisionHandler:(void (^)(WKNavigationActionPolicy))h {
    NSURL *u = a.request.URL;
    NSString *sc = u.scheme.lowercaseString;
    if ([sc isEqualToString:@"http"] || [sc isEqualToString:@"https"]) {
        if ([u.path hasPrefix:@"/api/app/"]) { [UIApplication.sharedApplication openURL:u options:@{} completionHandler:nil]; h(WKNavigationActionPolicyCancel); return; }
        h(WKNavigationActionPolicyAllow); return;
    }
    if ([sc isEqualToString:@"file"] || [sc isEqualToString:@"about"] || [sc isEqualToString:@"blob"] || [sc isEqualToString:@"data"]) { h(WKNavigationActionPolicyAllow); return; }
    [UIApplication.sharedApplication openURL:u options:@{} completionHandler:nil];
    h(WKNavigationActionPolicyCancel);
}
- (void)webView:(WKWebView *)w didFinishNavigation:(WKNavigation *)n { [self pushStatus]; }
- (void)webView:(WKWebView *)w didFailProvisionalNavigation:(WKNavigation *)n withError:(NSError *)e {
    if (e.code == NSURLErrorCancelled) return;
    [self goHome];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.8 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        [self js:@"var m=document.getElementById('msg');if(m){m.textContent='网络连接失败，请检查网络或切换线路';m.style.display='block';setTimeout(function(){m.style.display='none'},3000)}"];
    });
}
// 相机权限 (iOS 15+): 我们自己的页面直接允许
- (void)webView:(WKWebView *)w requestMediaCapturePermissionForOrigin:(WKSecurityOrigin *)o initiatedByFrame:(WKFrameInfo *)f type:(WKMediaCaptureType)t decisionHandler:(void (^)(WKPermissionDecision))h API_AVAILABLE(ios(15.0)) {
    h(WKPermissionDecisionGrant);
}
- (void)webView:(WKWebView *)w runJavaScriptAlertPanelWithMessage:(NSString *)m initiatedByFrame:(WKFrameInfo *)f completionHandler:(void (^)(void))h {
    UIAlertController *a = [UIAlertController alertControllerWithTitle:nil message:m preferredStyle:UIAlertControllerStyleAlert];
    [a addAction:[UIAlertAction actionWithTitle:@"好" style:UIAlertActionStyleDefault handler:^(UIAlertAction *x) { h(); }]];
    [self presentViewController:a animated:YES completion:nil];
}
- (void)webView:(WKWebView *)w runJavaScriptConfirmPanelWithMessage:(NSString *)m initiatedByFrame:(WKFrameInfo *)f completionHandler:(void (^)(BOOL))h {
    UIAlertController *a = [UIAlertController alertControllerWithTitle:nil message:m preferredStyle:UIAlertControllerStyleAlert];
    [a addAction:[UIAlertAction actionWithTitle:@"取消" style:UIAlertActionStyleCancel handler:^(UIAlertAction *x) { h(NO); }]];
    [a addAction:[UIAlertAction actionWithTitle:@"确定" style:UIAlertActionStyleDefault handler:^(UIAlertAction *x) { h(YES); }]];
    [self presentViewController:a animated:YES completion:nil];
}
@end

// ================================================================== App
@interface AppDelegate : UIResponder <UIApplicationDelegate>
@property (nonatomic, strong) UIWindow *window;
@end

@implementation AppDelegate
- (BOOL)application:(UIApplication *)app didFinishLaunchingWithOptions:(NSDictionary *)opts {
    self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
    self.window.rootViewController = [MainVC new];
    [self.window makeKeyAndVisible];
    return YES;
}
@end

int main(int argc, char *argv[]) {
    @autoreleasepool {
        return UIApplicationMain(argc, argv, nil, NSStringFromClass(AppDelegate.class));
    }
}
