// Wallpaper Engine Background: puts linux-wallpaperengine (scene/web wallpapers) behind the windows on GNOME.
//
// GNOME (Mutter) has no wlr-layer-shell, so linux-wallpaperengine can't make itself a background. This
// extension starts it in --window mode, one process per monitor, and turns each window into a DESKTOP-type
// window: bottom layer, on every workspace, hidden from the taskbar, Alt+Tab and the overview window picker.
// The real window stays under the pointer, so wallpapers still react to the mouse over the empty desktop.
// A clone of it is injected into background actors so the overview and lock screen show it too
// (same technique as the Hanabi extension, https://github.com/jeffshee/gnome-ext-hanabi).
//
// It is driven by ~/.config/hanabi-wallpapers/background.json, written by the Hanabi Wallpapers app:
//   {"dir": "/path/to/wallpaper", "kind": "scene" | "web", "preset": {...}, "volume": 0-100, "fps": 30}
// A missing file, or one without "dir", means "no wallpaper".

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

const CONFIG = GLib.build_filenamev([GLib.get_user_config_dir(), 'hanabi-wallpapers', 'background.json']);
const LIBCEF = ['/opt/linux-wallpaperengine/libcef.so'];
const STOP_GRACE_MS = 1500;

function readConfig() {
    try {
        const [, bytes] = GLib.file_get_contents(CONFIG);
        const cfg = JSON.parse(new TextDecoder().decode(bytes));
        return cfg && typeof cfg.dir === 'string' && cfg.dir ? cfg : null;
    } catch {
        return null;
    }
}

function signalGroup(pid, signal) {
    // processes run in their own session (setsid), so the group also holds the web engine's helper processes
    try {
        GLib.spawn_command_line_async(`kill -${signal} -- -${pid}`);
    } catch (e) {
        console.warn(`wpe-background: kill ${signal} ${pid}: ${e}`);
    }
}

export default class WpeBackground extends Extension {
    enable() {
        this._procs = [];          // {pid, monitor, window, actor, paused}
        this._clones = new Set();
        this._signals = [];
        this._injections = new InjectionManager();
        this._config = null;
        this._reloadId = 0;

        const self = this;
        this._injections.overrideMethod(Background.BackgroundManager.prototype, '_createBackgroundActor',
            original => function () {
                const backgroundActor = original.call(this);
                self._addClone(backgroundActor);
                return backgroundActor;
            });

        this._connect(global.display, 'window-created', (_d, w) => this._adopt(w));
        this._connect(global.display, 'in-fullscreen-changed', () => this._updatePause());
        this._connect(Main.layoutManager, 'monitors-changed', () => this._scheduleReload(1000));

        this._monitor = Gio.File.new_for_path(CONFIG).monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', () => this._scheduleReload(300));

        this._reload();
    }

    disable() {
        if (this._reloadId)
            GLib.source_remove(this._reloadId);
        this._monitor?.cancel();
        this._monitor = null;
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];
        this._injections.clear();
        this._stopAll();
        this._refreshBackgrounds();
    }

    _connect(obj, signal, cb) {
        this._signals.push([obj, obj.connect(signal, cb)]);
    }

    _scheduleReload(delay) {
        if (this._reloadId)
            GLib.source_remove(this._reloadId);
        this._reloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._reloadId = 0;
            this._reload();
            return GLib.SOURCE_REMOVE;
        });
    }

    _reload() {
        const cfg = readConfig();
        if (JSON.stringify(cfg) === JSON.stringify(this._config) && this._procs.length)
            return;
        this._config = cfg;
        this._stopAll();
        if (cfg)
            this._startAll(cfg);
        this._refreshBackgrounds();
    }

    _startAll(cfg) {
        const fps = Number.isInteger(cfg.fps) ? cfg.fps : 30;
        const volume = Number.isInteger(cfg.volume) ? cfg.volume : 0;
        const props = [];
        for (const [k, v] of Object.entries(cfg.preset ?? {})) {
            if (v !== null && typeof v !== 'object')
                props.push('--set-property', `${k}=${v}`);
        }
        const env = GLib.get_environ();
        const cef = cfg.kind === 'web' ? LIBCEF.find(p => GLib.file_test(p, GLib.FileTest.EXISTS)) : null;
        const launcherEnv = cef ? GLib.environ_setenv(env, 'LD_PRELOAD', cef, true) : env;

        for (let i = 0; i < global.display.get_n_monitors(); i++) {
            const g = global.display.get_monitor_geometry(i);
            const argv = ['setsid', 'linux-wallpaperengine',
                ...(volume > 0 ? ['--volume', `${volume}`] : ['--silent']),
                '--fps', `${fps}`, '--window', `${g.x}x${g.y}x${g.width}x${g.height}`, '--scaling', 'fill',
                ...props, cfg.dir];
            try {
                const [, pid] = GLib.spawn_async(null, argv, launcherEnv,
                    GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD, null);
                const proc = {pid, monitor: i, window: null, actor: null, paused: false};
                GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, (p, status) => {
                    GLib.spawn_close_pid(p);
                    if (this._procs.includes(proc))
                        console.warn(`wpe-background: linux-wallpaperengine on monitor ${i} exited (${status})`);
                });
                this._procs.push(proc);
            } catch (e) {
                console.error(`wpe-background: could not start linux-wallpaperengine: ${e}`);
            }
        }
        for (const actor of global.get_window_actors())
            this._adopt(actor.meta_window);
    }

    _stopAll() {
        for (const proc of this._procs) {
            for (const clone of [...this._clones]) {
                if (clone.source === proc.actor)
                    clone.destroy();
            }
            if (proc.paused)
                signalGroup(proc.pid, 'CONT');
            signalGroup(proc.pid, 'TERM');
            // the web engine ignores SIGTERM: make sure the whole group is gone
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, STOP_GRACE_MS, () => {
                signalGroup(proc.pid, 'KILL');
                return GLib.SOURCE_REMOVE;
            });
        }
        this._procs = [];
    }

    _adopt(window) {
        if (!window)
            return;
        const pid = window.get_pid();
        const proc = this._procs.find(p => p.pid === pid && !p.window);
        if (!proc)
            return;
        proc.window = window;
        window.set_type(Meta.WindowType.DESKTOP);
        window.stick();
        const place = () => {
            const g = global.display.get_monitor_geometry(proc.monitor);
            window.move_resize_frame(false, g.x, g.y, g.width, g.height);
        };
        // moving/resizing before the window is shown trips a Mutter check (window not ready)
        const id = window.connect('shown', () => {
            window.disconnect(id);
            place();
            proc.actor = window.get_compositor_private();
            this._refreshBackgrounds();
        });
        window.connect('unmanaged', () => {
            if (proc.window === window) {
                proc.window = null;
                proc.actor = null;
            }
        });
        this._updatePause();
    }

    _addClone(backgroundActor) {
        const proc = this._procs.find(p => p.monitor === backgroundActor.monitor && p.actor);
        if (!proc)
            return;
        const clone = new Clutter.Clone({source: proc.actor, x_expand: true, y_expand: true});
        backgroundActor.layout_manager = new Clutter.BinLayout();
        backgroundActor.add_child(clone);
        this._clones.add(clone);
        clone.connect('destroy', () => this._clones.delete(clone));
    }

    _refreshBackgrounds() {
        // background actors are created on demand: rebuild them so clones are added/removed
        global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            Main.layoutManager._updateBackgrounds();
            try {
                Main.overview._overview._controls._workspacesDisplay._updateWorkspacesViews();
            } catch {
                // overview internals moved; the overview simply shows the static background
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _updatePause() {
        // linux-wallpaperengine can't detect fullscreen on GNOME: freeze it while a game/video is fullscreen
        for (const proc of this._procs) {
            const fullscreen = global.display.get_monitor_in_fullscreen(proc.monitor);
            if (fullscreen !== proc.paused) {
                signalGroup(proc.pid, fullscreen ? 'STOP' : 'CONT');
                proc.paused = fullscreen;
            }
        }
    }
}
