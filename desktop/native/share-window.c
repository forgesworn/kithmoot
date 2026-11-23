// Reports only the selected capture window's bounds. No titles, pixels, input
// hooks or accessibility permissions. The parent owns the lifetime of this
// watcher.
#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#if defined(__APPLE__)
#include <ApplicationServices/ApplicationServices.h>
#include <unistd.h>
#elif defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <dwmapi.h>
#include <windows.h>
#else
#include <dlfcn.h>
#include <unistd.h>
typedef struct {
  int x, y, width, height, border_width, depth;
  void *visual;
  unsigned long root;
  int window_class, bit_gravity, win_gravity, backing_store;
  unsigned long backing_planes, backing_pixel;
  int save_under;
  unsigned long colormap;
  int map_installed, map_state;
  long all_event_masks, your_event_mask, do_not_propagate_mask;
  int override_redirect;
  void *screen;
} WindowAttributes;
static int ignore_x_error(void *display, void *error) {
  (void)display;
  (void)error;
  return 0;
}
#endif
int main(int argc, char **argv) {
  if (argc != 2)
    return 2;
  char *end;
  errno = 0;
  unsigned long long id = strtoull(argv[1], &end, 10);
  if (errno || *end || !id)
    return 2;
#if !defined(__APPLE__) && !defined(_WIN32)
  void *lib = dlopen("libX11.so.6", RTLD_NOW | RTLD_LOCAL);
  if (!lib)
    return 3;
  void *(*open_display)(const char *) = dlsym(lib, "XOpenDisplay");
  int (*attributes)(void *, unsigned long, WindowAttributes *) =
      dlsym(lib, "XGetWindowAttributes");
  int (*translate)(void *, unsigned long, unsigned long, int, int, int *, int *,
                   unsigned long *) = dlsym(lib, "XTranslateCoordinates");
  void *(*errors)(void *) = dlsym(lib, "XSetErrorHandler");
  if (!open_display || !attributes || !translate || !errors)
    return 3;
  void *display = open_display(NULL);
  if (!display)
    return 3;
  errors(ignore_x_error);
#endif
  for (;;) {
    double x = 0, y = 0, w = 0, h = 0;
    bool visible = false, exists = false;
#if defined(__APPLE__)
    // IncludingWindow omits a minimised window, which would terminate the
    // watcher and prevent its overlay returning when the window is restored.
    CFArrayRef rows =
        CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID);
    for (CFIndex i = 0; rows && i < CFArrayGetCount(rows); i++) {
      CFDictionaryRef row = CFArrayGetValueAtIndex(rows, i);
      int64_t number = 0;
      CFNumberRef value = CFDictionaryGetValue(row, kCGWindowNumber);
      if (!value || !CFNumberGetValue(value, kCFNumberSInt64Type, &number) ||
          (unsigned long long)number != id)
        continue;
      CGRect rect;
      if (CGRectMakeWithDictionaryRepresentation(
              CFDictionaryGetValue(row, kCGWindowBounds), &rect)) {
        exists = true;
        visible =
            CFDictionaryGetValue(row, kCGWindowIsOnscreen) == kCFBooleanTrue;
        x = rect.origin.x;
        y = rect.origin.y;
        w = rect.size.width;
        h = rect.size.height;
      }
      break;
    }
    if (rows)
      CFRelease(rows);
#elif defined(_WIN32)
    // Use physical coordinates even when the other window has a different DPI.
    SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    HWND window = (HWND)(uintptr_t)id;
    RECT rect;
    DWORD cloaked = 0;
    exists = IsWindow(window);
    visible = exists && IsWindowVisible(window) && !IsIconic(window);
    if (exists &&
        SUCCEEDED(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS,
                                        &rect, sizeof(rect)))) {
      x = rect.left;
      y = rect.top;
      w = rect.right - rect.left;
      h = rect.bottom - rect.top;
      if (SUCCEEDED(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked,
                                          sizeof(cloaked))) &&
          cloaked)
        visible = false;
    } else
      visible = false;
#else
    WindowAttributes a;
    exists = attributes(display, (unsigned long)id, &a) != 0;
    if (exists) {
      int px, py;
      unsigned long child;
      visible = a.map_state == 2 && translate(display, (unsigned long)id,
                                              a.root, 0, 0, &px, &py, &child);
      if (visible) {
        x = px;
        y = py;
        w = a.width;
        h = a.height;
      }
    }
#endif
    if (visible && w > 0 && h > 0)
      printf("{\"x\":%.3f,\"y\":%.3f,\"width\":%.3f,\"height\":%.3f}\n", x, y,
             w, h);
    else
      puts("null");
    fflush(stdout);
    if (!exists)
      return 0;
#if defined(_WIN32)
    Sleep(50);
#else
    usleep(50000);
#endif
  }
}
