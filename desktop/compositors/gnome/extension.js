import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class KithMootMarks extends Extension {
  enable() {
    this._http = new Soup.Session({timeout: 2}); this._state = null; this._points = [];
    this._canvas = new St.Widget({reactive: false, layout_manager: new Clutter.BinLayout()}); Main.uiGroup.add_child(this._canvas);
    this._drawingArea = new St.DrawingArea({reactive: false, x_expand: true, y_expand: true});
    this._canvas.add_child(this._drawingArea);
    this._drawingArea.connect('repaint', area => this._paint(area));
    this._toolbar = new St.BoxLayout({reactive: true, x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START, margin_top: 8, margin_right: 8, style: 'background-color: #101114; spacing: 6px; padding: 6px; border-radius: 6px;'});
    const button = (label, action) => {
      const node = new St.Button({label, reactive: true, can_focus: true, style: 'color: white; background-color: #35383e; padding: 8px;'});
      node.connect('clicked', action); this._toolbar.add_child(node); return node;
    };
    this._drawButton = button('Draw', () => this._toggle());
    button('Clear', () => this._post('/action', {action: 'clear'}));
    button('Stop sharing', () => this._post('/action', {action: 'stop'}));
    this._canvas.add_child(this._toolbar);
    // Two compositor shortcuts, configured through the companion's schema.
    this._settings = this.getSettings('org.gnome.shell.extensions.kithmoot-marks');
    Main.wm.addKeybinding('attach-draw', this._settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL, () => this._toggle('window'));
    Main.wm.addKeybinding('attach-screen', this._settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL, () => this._toggle('screen'));
    Main.wm.addKeybinding('clear', this._settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.ALL, () => this._post('/action', {action: 'clear'}));
    this._event = this._canvas.connect('captured-event', (_actor, event) => this._input(event));
    this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { this._poll(); this._layout(); return GLib.SOURCE_CONTINUE; });
  }
  _connection() {
    const path = GLib.build_filenamev([GLib.get_user_state_dir(), 'kithmoot', 'annotations.json']);
    try { const [ok, bytes] = GLib.file_get_contents(path); return ok ? JSON.parse(new TextDecoder().decode(bytes)) : null; } catch { return null; }
  }
  _poll() {
    if (this._pending) return;
    const connection = this._connection();
    if (!connection || !/^http:\/\/127\.0\.0\.1:\d+$/.test(connection.url) || !/^[a-f0-9]{64}$/.test(connection.token)) { this._reset(); return; }
    this._pending = true;
    const message = Soup.Message.new('GET', `${connection.url}/state`);
    message.request_headers.append('Authorization', `Bearer ${connection.token}`);
    this._http.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
      this._pending = false;
      try {
        const bytes = session.send_and_read_finish(result);
        if (!this._canvas || message.status_code !== 200 || bytes.get_size() > 262144) { this._reset(); return; }
        const value = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        if (!value || typeof value.session !== 'string' || !['window','screen'].includes(value.kind) || !Array.isArray(value.strokes)) { this._reset(); return; }
        if (this._state?.session !== value.session) { this._reset(); Main.notify('KithMoot drawing', 'Focus the shared window and press Super+Shift+D, or focus the shared display and press Super+Shift+S. Escape returns to normal use.'); }
        this._state = value; this._connectionValue = connection; this._drawingArea.queue_repaint();
      } catch { this._reset(); }
    });
  }
  _cursor(drawing) {
    if (!this._canvas) return;
    // GNOME 50 moved cursor selection from MetaDisplay to ClutterActor.
    if (this._canvas?.set_cursor_type) this._canvas.set_cursor_type(drawing ? Clutter.CursorType.CROSSHAIR : Clutter.CursorType.INHERIT);
    else global.display.set_cursor(drawing ? Meta.Cursor.CROSSHAIR : Meta.Cursor.DEFAULT);
  }
  _endDrawing() {
    this._drawing = false; this._points = [];
    if (this._canvas) this._canvas.reactive = false;
    if (this._grab) Main.popModal(this._grab);
    this._grab = null; this._drawButton?.set_label('Draw');
    this._cursor(false);
  }
  _reset() { this._endDrawing(); this._target = null; this._state = null; this._canvas?.hide(); }
  _toggle(kind) {
    if (!this._state) return;
    if (kind && this._state.kind !== kind) { this._endDrawing(); this._target = null; this._state.kind = kind; this._post('/target', {kind}); }
    if (!this._target) {
      const window = global.display.focus_window;
      if (!window || window.is_skip_taskbar()) return;
      this._target = window;
      this._monitor = Main.layoutManager.monitors[window.get_monitor()];
    }
    if (this._drawing) { this._flush(); this._endDrawing(); return; }
    this._canvas.reactive = true;
    this._grab = Main.pushModal(this._canvas, {actionMode: Shell.ActionMode.NORMAL});
    if (!(this._grab.get_seat_state() & Clutter.GrabState.POINTER)) { Main.popModal(this._grab); this._grab = null; this._canvas.reactive = false; return; }
    this._drawing = true; this._drawButton.set_label('Use window');
    this._cursor(this._drawing);
  }
  _layout() {
    if (!this._state || !this._target || (this._state.kind === 'window' && (this._target.minimized || this._target.get_compositor_private() === null)) || (this._state.kind === 'screen' && !Main.layoutManager.monitors.includes(this._monitor))) { this._endDrawing(); this._canvas.hide(); return; }
    const visible = this._drawing || this._state.kind === 'screen' || global.display.focus_window === this._target;
    if (!visible) { this._canvas.hide(); return; }
    const rect = this._state.kind === 'screen' ? this._monitor : this._target.get_frame_rect();
    this._canvas.set_position(rect.x, rect.y); this._canvas.set_size(rect.width, rect.height); this._canvas.show(); this._drawingArea.queue_repaint();
  }
  _paint(area) {
    const cr = area.get_context(), [width, height] = area.get_surface_size();
    for (const stroke of this._state?.strokes ?? []) {
      if (!Array.isArray(stroke.points) || stroke.points.length > 256 || !/^#[a-fA-F0-9]{6}$/.test(stroke.color) || !Number.isFinite(stroke.alpha)) continue;
      const hex = stroke.color.slice(1); cr.setSourceRGBA(parseInt(hex.slice(0,2),16)/255, parseInt(hex.slice(2,4),16)/255, parseInt(hex.slice(4,6),16)/255, Math.max(0,Math.min(1,stroke.alpha)));
      cr.setLineWidth(Math.max(3,width/260)); cr.setLineCap(1); cr.setLineJoin(1);
      stroke.points.forEach((p,i) => { if (i) cr.lineTo(p.x*width,p.y*height); else cr.moveTo(p.x*width,p.y*height); }); cr.stroke();
    }
    cr.$dispose();
  }
  _input(event) {
    const source = event.get_source();
    if (source && this._toolbar.contains(source)) return Clutter.EVENT_PROPAGATE;
    if (!this._drawing || !this._canvas.visible) return Clutter.EVENT_PROPAGATE;
    if (event.type() === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) { this._toggle(); return Clutter.EVENT_STOP; }
    const [x,y] = event.get_coords(), [left,top] = this._canvas.get_position(), [width,height] = this._canvas.get_size();
    const point = {x: Math.max(0,Math.min(1,(x-left)/width)),y: Math.max(0,Math.min(1,(y-top)/height))};
    if (event.type() === Clutter.EventType.BUTTON_PRESS && event.get_button() === 1 && x >= left && y >= top && x <= left + width && y <= top + height) { this._points = [point]; this._sent = 0; }
    if (event.type() === Clutter.EventType.MOTION && this._points.length) { this._points.push(point); if (Date.now()-this._sent >= 50 || this._points.length >= 128) this._flush(true); }
    if (event.type() === Clutter.EventType.BUTTON_RELEASE) this._flush();
    return Clutter.EVENT_STOP;
  }
  _flush(continued = false) { if (this._points.length > 1) this._post('/stroke', {points: this._points}); this._points = continued && this._points.length ? [this._points.at(-1)] : []; this._sent = Date.now(); }
  _post(path, value) {
    if (!this._state || !this._connectionValue) return;
    const message = Soup.Message.new('POST', this._connectionValue.url + path);
    message.request_headers.append('Authorization', `Bearer ${this._connectionValue.token}`);
    message.set_request_body_from_bytes('application/json', new GLib.Bytes(new TextEncoder().encode(JSON.stringify({...value, session: this._state.session}))));
    this._http.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session,result) => { try { session.send_and_read_finish(result); } catch {} });
  }
  disable() {
    this._reset(); if (this._timer) GLib.source_remove(this._timer);
    this._canvas.disconnect(this._event); Main.wm.removeKeybinding('attach-draw'); Main.wm.removeKeybinding('attach-screen'); Main.wm.removeKeybinding('clear');
    this._http.abort(); this._canvas.destroy(); this._canvas = null; this._settings = null;
    this._cursor(false);
  }
}
