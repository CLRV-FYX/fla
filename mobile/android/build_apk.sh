#!/usr/bin/env bash
# 无 Gradle / 无 Android SDK 的 APK 构建 (沙箱只能连 PyPI / npm / github.com 时使用)
# 工具链 (放在 $T, 默认 /tmp/apktools):
#   java     : PyPI jdk4py 自带的 JRE
#   javac    : npm dataslope-tools-jar (OpenJDK8 tools.jar)
#   aapt2    : npm aaptjs3 (linux x64 预编译)
#   d8       : npm d8-termux 的 dex 版 → google/enjarify 转回 JVM 字节码 (见 prepare_tools)
#   apksigner: github MuntashirAkon/apksig-android 源码编译 (+ android.util.Base64/os.Build 垫片)
#   android.jar: github Sable/android-platforms (android-34 链接, android-28 编译)
# 用法: bash mobile/android/build_apk.sh   产物: desktop/bin/FLA-cast.apk
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
T="${T:-/tmp/apktools}"
JAVA="$T/jre/bin/java"
JC="$JAVA -cp $T/tools.jar com.sun.tools.javac.Main"
D8="$JAVA -XX:+UnlockDiagnosticVMOptions -XX:-BytecodeVerificationRemote -XX:-BytecodeVerificationLocal -cp $T/d8/c1.jar:$T/d8/c2.jar:$T/d8/c3.jar com.android.tools.r8.D8"
SIGN="$JAVA -cp $T/apksig com.android.apksigner.ApkSignerTool"
A34="$T/android-34.jar"; A28="$T/android-28.jar"
for f in "$JAVA" "$T/tools.jar" "$T/aapt2" "$A34" "$A28" "$T/d8/c1.jar" "$T/apksig/com/android/apksigner/ApkSignerTool.class"; do
  [ -e "$f" ] || { echo "缺少工具: $f (先准备工具链, 见文件头注释)"; exit 1; }
done

APP="$HERE/app/src/main"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
VC=$(grep -o 'versionCode [0-9]*' "$HERE/app/build.gradle" | awk '{print $2}')
VN=$(grep -o 'versionName "[^"]*"' "$HERE/app/build.gradle" | cut -d'"' -f2)
echo ">> FLA 投屏 $VN ($VC)"

# 1. 资源 + 清单 (Gradle 用 namespace, aapt2 直连需要 package 属性)
sed 's#<manifest xmlns:android="http://schemas.android.com/apk/res/android">#<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="top.clrv.fla">#' "$APP/AndroidManifest.xml" > "$W/AndroidManifest.xml"
"$T/aapt2" compile --dir "$APP/res" -o "$W/res.zip"
"$T/aapt2" link -I "$A34" --manifest "$W/AndroidManifest.xml" "$W/res.zip" \
  --min-sdk-version 24 --target-sdk-version 34 --version-code "$VC" --version-name "$VN" \
  -o "$W/base.apk"

# 2. Java → class → dex
mkdir -p "$W/cls" "$W/dex"
$JC -nowarn -source 8 -target 8 -encoding UTF-8 -bootclasspath "$A34" -d "$W/cls" $(find "$APP/java" -name "*.java")
$D8 --release --lib "$A34" --min-api 24 --output "$W/dex" $(find "$W/cls" -name "*.class")

# 3. 合并 + 4 字节对齐 (resources.arsc 必须不压缩且对齐)
python3 - "$W/base.apk" "$W/dex/classes.dex" "$W/unsigned.apk" <<'PY'
import sys, zipfile
src, dex, dst = sys.argv[1:]
zin = zipfile.ZipFile(src)
entries = [(i.filename, zin.read(i.filename)) for i in zin.infolist()] + [("classes.dex", open(dex, "rb").read())]
with open(dst, "wb") as f:
    z = zipfile.ZipFile(f, "w")
    for name, data in entries:
        stored = name == "resources.arsc" or name.endswith(".png")
        zi = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
        zi.compress_type = zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED
        if stored:   # 对齐: 本地文件头 30 + 文件名 + extra
            off = f.tell() + 30 + len(name.encode())
            pad = (-off) % 4
            zi.extra = b"\0" * pad
        z.writestr(zi, data)
    z.close()
PY

# 4. 签名 (v1 + v2 + v3) 并校验
mkdir -p "$ROOT/desktop/bin"
$SIGN sign --ks "$HERE/keystore/fla.p12" --ks-type PKCS12 --ks-pass pass:flafla --ks-key-alias fla --key-pass pass:flafla \
  --min-sdk-version 24 --v4-signing-enabled false --out "$ROOT/desktop/bin/FLA-cast.apk" "$W/unsigned.apk"
$SIGN verify --verbose --min-sdk-version 24 "$ROOT/desktop/bin/FLA-cast.apk" | head -6
ls -la "$ROOT/desktop/bin/FLA-cast.apk"
