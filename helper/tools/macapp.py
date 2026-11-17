#!/usr/bin/env python3
"""Mac 用の「shimau ヘルパー.app」を Pi（Linux）上で組み立てる。

Mac の lipo / iconutil が無くても作れるように、次を自前で行う。
- arm64 と amd64 のヘルパーを 1 つのユニバーサルバイナリにまとめる
- 拡張機能のアイコン（PNG）から AppIcon.icns を作る
- Info.plist を書く

使い方: macapp.py <出力 .app> <版> <arm64 バイナリ> <amd64 バイナリ> <アイコン PNG>
"""
import os
import plistlib
import struct
import sys

CPU_ARCH_ABI64 = 0x01000000
ALIGN = {0x0100000C: 14, 0x01000007: 12}  # arm64: 16KB, x86_64: 4KB（lipo と同じ）


def thin_header(data):
    magic, cputype, cpusubtype = struct.unpack_from("<III", data, 0)
    if magic != 0xFEEDFACF:
        sys.exit("64bit の Mach-O ではありません")
    return cputype, cpusubtype


def fat(binaries):
    slices = []
    for b in binaries:
        cputype, sub = thin_header(b)
        slices.append((cputype, sub, b))
    slices.sort(key=lambda s: s[0] != 0x01000007)  # x86_64 を先に（lipo の並びに合わせる）
    header = struct.pack(">II", 0xCAFEBABE, len(slices))
    offset = 4096
    entries, body = b"", b""
    cur = 8 + 20 * len(slices)
    out_parts = []
    for cputype, sub, data in slices:
        align = ALIGN.get(cputype, 14)
        offset = (max(offset, cur) + (1 << align) - 1) // (1 << align) * (1 << align)
        entries += struct.pack(">iiIII", cputype, sub, offset, len(data), align)
        out_parts.append((offset, data))
        cur = offset + len(data)
    buf = bytearray(cur)
    buf[0:8 + len(entries)] = header + entries
    for off, data in out_parts:
        buf[off:off + len(data)] = data
    return bytes(buf)


def icns(png):
    # ic07 = 128×128 の PNG をそのまま入れる
    entry = b"ic07" + struct.pack(">I", 8 + len(png)) + png
    return b"icns" + struct.pack(">I", 8 + len(entry)) + entry


def main():
    app, version, arm, amd, icon = sys.argv[1:6]
    macos = os.path.join(app, "Contents", "MacOS")
    res = os.path.join(app, "Contents", "Resources")
    os.makedirs(macos)
    os.makedirs(res)
    with open(arm, "rb") as f:
        a = f.read()
    with open(amd, "rb") as f:
        b = f.read()
    exe = os.path.join(macos, "shimau-helper")
    with open(exe, "wb") as f:
        f.write(fat([a, b]))
    os.chmod(exe, 0o755)
    with open(icon, "rb") as f:
        png = f.read()
    with open(os.path.join(res, "AppIcon.icns"), "wb") as f:
        f.write(icns(png))
    info = {
        "CFBundleDevelopmentRegion": "ja",
        "CFBundleDisplayName": "shimau ヘルパー",
        "CFBundleExecutable": "shimau-helper",
        "CFBundleIconFile": "AppIcon",
        "CFBundleIdentifier": "com.shimau.helper",
        "CFBundleInfoDictionaryVersion": "6.0",
        "CFBundleName": "shimau ヘルパー",
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": version,
        "CFBundleVersion": version,
        "LSMinimumSystemVersion": "11.0",
        "LSUIElement": True,  # Dock にアイコンを出さない（ダイアログだけ出して終わる）
        "NSHighResolutionCapable": True,
    }
    with open(os.path.join(app, "Contents", "Info.plist"), "wb") as f:
        plistlib.dump(info, f)


if __name__ == "__main__":
    main()
