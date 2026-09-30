"""Where the Electron binary and the packaged app live, per platform (the gate tools share it)."""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def dev_electron():
    """Returns the dev Electron binary of this checkout's node_modules."""
    dist = os.path.join(ROOT, "node_modules", "electron", "dist")
    if os.name == "nt":
        return os.path.join(dist, "electron.exe")
    if sys.platform == "darwin":
        return os.path.join(dist, "Electron.app", "Contents", "MacOS", "Electron")
    return os.path.join(dist, "electron")


def app_executable(exe):
    """Returns the executable inside a macOS .app bundle, or exe itself."""
    if exe and exe.rstrip("/").endswith(".app"):
        name = os.path.splitext(os.path.basename(exe.rstrip("/")))[0]
        return os.path.join(exe, "Contents", "MacOS", name)
    return exe


def packaged_asar(exe):
    """Returns the app.asar next to a packaged executable (resources/ on Windows and Linux, Contents/Resources on macOS)."""
    exe = app_executable(exe)
    if sys.platform == "darwin":
        return os.path.join(os.path.dirname(os.path.dirname(exe)), "Resources", "app.asar")
    return os.path.join(os.path.dirname(exe), "resources", "app.asar")
