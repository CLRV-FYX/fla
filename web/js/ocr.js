/* FLA v1.27 - AI 视觉与文字识别同步模块 (FLA_OCR)
 * 作用: 识别微软 Office Online 底部状态栏 "第N张幻灯片，共M张" / "幻灯片 N / M" / "Slide N of M",
 *      使板书画布全自动随微软翻页切换，老师无需在"自翻"与"微软"之间手动选择。
 */
(function (global) {
  'use strict';

  var stream = null;
  var video = null;
  var scanTimer = null;
  var isScanning = false;
  var lastDetectedPage = -1;
  var offCanvas = null;
  var offCtx = null;

  /* ==================================================================
   *  1. 文本解析引擎: 抽取页码与总页数
   * ================================================================== */
  function parseSlideNumber(text) {
    if (!text || typeof text !== 'string') return null;
    var s = text.replace(/[\r\n\t]+/g, ' ').trim();
    if (!s) return null;

    // 格式 1: "第 1 张幻灯片，共 5 张" / "第1张" / "第 1/5 张"
    var m = s.match(/第\s*(\d{1,4})\s*张(?:幻灯片)?/);
    if (m) {
      var cur = parseInt(m[1], 10);
      var tm = s.match(/共\s*(\d{1,4})\s*张/);
      return { cur: cur, total: tm ? parseInt(tm[1], 10) : 0, raw: s };
    }

    // 格式 2: "幻灯片 2 / 10" / "幻灯片 2"
    m = s.match(/幻灯片\s*(\d{1,4})(?:\s*[\/之,，]\s*(\d{1,4}))?/);
    if (m) {
      return { cur: parseInt(m[1], 10), total: m[2] ? parseInt(m[2], 10) : 0, raw: s };
    }

    // 格式 3: "Slide 3 of 15" / "Slide 3 / 15"
    m = s.match(/Slide\s*(\d{1,4})(?:\s*(?:of|\/)\s*(\d{1,4}))?/i);
    if (m) {
      return { cur: parseInt(m[1], 10), total: m[2] ? parseInt(m[2], 10) : 0, raw: s };
    }

    // 格式 4: "1 / 5" 或 "1 of 5"
    m = s.match(/\b(\d{1,4})\s*(?:\/|of|之)\s*(\d{1,4})\b/i);
    if (m) {
      return { cur: parseInt(m[1], 10), total: parseInt(m[2], 10), raw: s };
    }

    // 格式 5: 单独孤立数字 (如底部简略指示 "3")
    m = s.match(/^\s*(\d{1,4})\s*$/);
    if (m) {
      return { cur: parseInt(m[1], 10), total: 0, raw: s };
    }

    return null;
  }

  /* ==================================================================
   *  2. 画布识别 (TextDetector / Tesseract / 纯 JS 光栅投影分析)
   * ================================================================== */
  async function recognizeCanvas(canvas) {
    if (!canvas) return null;

    // 方案 A: 浏览器原生 Shape Detection API (Chrome/Edge 内置硬件加速 OCR)
    if ('TextDetector' in window) {
      try {
        var detector = new window.TextDetector();
        var detected = await detector.detect(canvas);
        if (detected && detected.length > 0) {
          for (var i = 0; i < detected.length; i++) {
            var raw = (detected[i].rawValue || '').trim();
            var parsed = parseSlideNumber(raw);
            if (parsed && parsed.cur > 0) return parsed;
          }
        }
      } catch (err) {
        // 部分浏览器权限限制，降级走方案 B/C
      }
    }

    // 方案 B: 本地 Tesseract.js 引擎 (若已加载)
    if (window.Tesseract && typeof window.Tesseract.recognize === 'function') {
      try {
        var res = await window.Tesseract.recognize(canvas, 'eng', {
          tessedit_char_whitelist: '0123456789/Slideof第张幻灯片共 '
        });
        if (res && res.data && res.data.text) {
          var p = parseSlideNumber(res.data.text);
          if (p && p.cur > 0) return p;
        }
      } catch (e2) {}
    }

    // 方案 C: 毫秒级轻量化纯 JS 投影二值化分析器 (零依赖)
    return rasterScanDigits(canvas);
  }

  /* 方案 C 的二值化与特征匹配 */
  function rasterScanDigits(canvas) {
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;
    var w = canvas.width, h = canvas.height;
    if (w < 10 || h < 10) return null;

    var img = ctx.getImageData(0, 0, w, h);
    var d = img.data;

    // 1. 判断背景明暗 (以四角取样)
    var bgLum = (lum(d, 0) + lum(d, (w - 1) * 4) + lum(d, (h - 1) * w * 4) + lum(d, (h * w - 1) * 4)) / 4;
    var isDarkBg = bgLum < 128;
    var threshold = isDarkBg ? 160 : 90;

    // 2. 统计每列前景点数量 (垂直投影直方图)
    var colSum = new Int32Array(w);
    for (var x = 0; x < w; x++) {
      var s = 0;
      for (var y = 0; y < h; y++) {
        var l = lum(d, (y * w + x) * 4);
        var isFg = isDarkBg ? (l > threshold) : (l < threshold);
        if (isFg) s++;
      }
      colSum[x] = s;
    }

    // 3. 寻找字符连通块区间
    var boxes = [];
    var inChar = false, startX = 0;
    for (var cx = 0; cx < w; cx++) {
      if (colSum[cx] >= 2) {
        if (!inChar) { inChar = true; startX = cx; }
      } else {
        if (inChar) {
          inChar = false;
          var cw = cx - startX;
          if (cw >= 2 && cw <= 40) {
            boxes.push({ x: startX, w: cw });
          }
        }
      }
    }
    if (inChar && (w - startX >= 2)) {
      boxes.push({ x: startX, w: w - startX });
    }

    // 若找到两个或以上字符块，按左右顺序解析
    if (boxes.length === 0) return null;

    // 尝试识别每个字符块 (数字 0-9 或 斜杠 /)
    var recognized = '';
    for (var bi = 0; bi < boxes.length; bi++) {
      var b = boxes[bi];
      var ch = matchGlyph(d, w, h, b.x, b.w, isDarkBg, threshold);
      if (ch) recognized += ch;
    }

    return parseSlideNumber(recognized);
  }

  function lum(d, idx) {
    return (d[idx] * 299 + d[idx + 1] * 587 + d[idx + 2] * 114) / 1000;
  }

  function matchGlyph(d, fullW, fullH, gx, gw, isDarkBg, threshold) {
    // 计算该字符块的上下边界
    var minY = fullH, maxY = 0;
    for (var y = 0; y < fullH; y++) {
      for (var x = gx; x < gx + gw; x++) {
        var l = lum(d, (y * fullW + x) * 4);
        var isFg = isDarkBg ? (l > threshold) : (l < threshold);
        if (isFg) {
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    var gh = maxY - minY + 1;
    if (gh < 6) return '';

    var aspect = gw / gh;
    // 瘦长垂直线 -> 数字 1
    if (aspect < 0.42) return '1';

    // 归一化为 8x12 采样矩阵
    var mat = new Uint8Array(8 * 12);
    for (var my = 0; my < 12; my++) {
      for (var mx = 0; mx < 8; mx++) {
        var srcX = Math.min(fullW - 1, Math.floor(gx + (mx / 8) * gw));
        var srcY = Math.min(fullH - 1, Math.floor(minY + (my / 12) * gh));
        var l2 = lum(d, (srcY * fullW + srcX) * 4);
        mat[my * 8 + mx] = (isDarkBg ? (l2 > threshold) : (l2 < threshold)) ? 1 : 0;
      }
    }

    // 斜杠 '/' 判定: 右上至左下对角分布
    var topRightMass = mat[1 * 8 + 6] + mat[2 * 8 + 5] + mat[3 * 8 + 5];
    var botLeftMass = mat[9 * 8 + 1] + mat[10 * 8 + 2] + mat[11 * 8 + 1];
    var centerHole = mat[5 * 8 + 3] + mat[6 * 8 + 4];
    if (topRightMass >= 2 && botLeftMass >= 2 && centerHole === 0 && aspect < 0.8) {
      return '/';
    }

    // 核心孔洞采样 (数字 0, 8, 6, 9)
    var midHole = (mat[5 * 8 + 3] === 0 && mat[5 * 8 + 4] === 0 && mat[6 * 8 + 3] === 0 && mat[6 * 8 + 4] === 0);
    var topHole = (mat[3 * 8 + 3] === 0 && mat[3 * 8 + 4] === 0 && mat[4 * 8 + 3] === 0);
    var btmHole = (mat[8 * 8 + 3] === 0 && mat[8 * 8 + 4] === 0 && mat[9 * 8 + 3] === 0);

    if (topHole && btmHole) return '8';
    if (midHole) return '0';
    if (topHole) return '9';
    if (btmHole) return '6';

    // 顶部水平横条 (7, 5)
    var topBar = mat[0 * 8 + 1] + mat[0 * 8 + 2] + mat[0 * 8 + 3] + mat[0 * 8 + 4] + mat[0 * 8 + 5] + mat[0 * 8 + 6];
    if (topBar >= 4) {
      if (mat[11 * 8 + 1] === 0 && mat[11 * 8 + 2] === 0) return '7';
      return '5';
    }

    // 底部水平横条 (2)
    var botBar = mat[11 * 8 + 1] + mat[11 * 8 + 2] + mat[11 * 8 + 3] + mat[11 * 8 + 4] + mat[11 * 8 + 5] + mat[11 * 8 + 6];
    if (botBar >= 4) return '2';

    // 右侧贯穿竖线 (4)
    var rightCol = mat[4 * 8 + 6] + mat[5 * 8 + 6] + mat[6 * 8 + 6] + mat[7 * 8 + 6] + mat[8 * 8 + 6];
    if (rightCol >= 4 && mat[6 * 8 + 1] === 1) return '4';

    // 默认判断: 3
    if (mat[1 * 8 + 6] === 1 && mat[6 * 8 + 5] === 1 && mat[10 * 8 + 6] === 1) return '3';

    return '';
  }

  /* ==================================================================
   *  3. 屏幕/标签页视频捕获与实时识别循环
   * ================================================================== */
  async function startCapture(options) {
    options = options || {};
    var onPage = options.onPage;
    var onStatus = options.onStatus;
    var onError = options.onError;

    if (stream) stopCapture();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      var err = new Error('当前浏览器环境不支持屏幕捕获 API (getDisplayMedia)');
      if (onError) onError(err);
      throw err;
    }

    try {
      // 优先提示捕获当前浏览器标签页 (Chrome/Edge 体验最佳)
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'browser'
        },
        audio: false,
        preferCurrentTab: true
      });
    } catch (e) {
      if (onError) onError(e);
      throw e;
    }

    video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.style.position = 'fixed';
    video.style.top = '-9999px';
    video.style.left = '-9999px';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    document.body.appendChild(video);

    offCanvas = document.createElement('canvas');
    offCtx = offCanvas.getContext('2d', { willReadFrequently: true });

    isScanning = true;
    lastDetectedPage = -1;

    // 当用户在系统或浏览器横幅点击"停止共享"时自动注销
    var track = stream.getVideoTracks()[0];
    if (track) {
      track.onended = function () {
        stopCapture();
        if (onStatus) onStatus({ active: false, reason: 'ended' });
      };
    }

    if (onStatus) onStatus({ active: true });

    // 周期扫描循环 (每 360ms 截取底部栏区域识别)
    scanTimer = setInterval(async function () {
      if (!isScanning || !video || video.readyState < 2) return;
      var vw = video.videoWidth;
      var vh = video.videoHeight;
      if (!vw || !vh) return;

      /* 微软 PowerPoint Online 的底部状态栏通常位于窗口底部 45px 区域,
       * 页码指示文字在左侧/中左侧 (0% ~ 48% 宽度区间)
       */
      var cropH = Math.min(65, Math.floor(vh * 0.12));
      var cropY = vh - cropH;
      var cropW = Math.floor(vw * 0.48);
      var cropX = 0;

      offCanvas.width = cropW;
      offCanvas.height = cropH;
      try {
        offCtx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
        var res = await recognizeCanvas(offCanvas);
        if (res && res.cur > 0) {
          if (res.cur !== lastDetectedPage) {
            lastDetectedPage = res.cur;
            if (onPage) onPage(res);
          }
        }
      } catch (err2) {
        // 忽略单帧识别偶发异常
      }
    }, 360);

    return true;
  }

  function stopCapture() {
    isScanning = false;
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    if (stream) {
      stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
      stream = null;
    }
    if (video) {
      if (video.parentNode) video.parentNode.removeChild(video);
      video = null;
    }
    offCanvas = null;
    offCtx = null;
    lastDetectedPage = -1;
  }

  function isCapturing() {
    return isScanning && !!stream;
  }

  /* 暴露到全局 */
  global.FLA_OCR = {
    parseSlideNumber: parseSlideNumber,
    recognizeCanvas: recognizeCanvas,
    startCapture: startCapture,
    stopCapture: stopCapture,
    isCapturing: isCapturing
  };

})(typeof window !== 'undefined' ? window : globalThis);
