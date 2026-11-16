// SPDX-License-Identifier: MIT
#include <KGlobalAccel>
#include <QAction>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QKeyEvent>
#include <QMouseEvent>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QPainter>
#include <QPointer>
#include <QTimer>
#include <core/output.h>
#include <core/rendertarget.h>
#include <core/renderviewport.h>
#include <effect/effect.h>
#include <effect/effecthandler.h>
#include <effect/effectwindow.h>
#include <opengl/glplatform.h>
#include <opengl/glutils.h>
#if KM_KWIN_67
#include <input_event.h>
#endif

namespace KWin {
#if KM_KWIN_66
using DrawingOutput = LogicalOutput;
using DrawingRegion = Region;
#else
using DrawingOutput = Output;
using DrawingRegion = QRegion;
#endif
class KithMootMarks final : public Effect {
  Q_OBJECT
public:
  KithMootMarks() {
    auto attach = new QAction(this);
    attach->setObjectName(QStringLiteral("KithMootAttachDrawing"));
    attach->setText(QStringLiteral(
        "KithMoot: attach drawings to the shared window and toggle drawing"));
    KGlobalAccel::self()->setDefaultShortcut(
        attach, {QKeySequence(QStringLiteral("Meta+Shift+D"))});
    KGlobalAccel::self()->setShortcut(
        attach, {QKeySequence(QStringLiteral("Meta+Shift+D"))});
    connect(attach, &QAction::triggered, this,
            [this] { toggle(QStringLiteral("window")); });
    auto display = new QAction(this);
    display->setObjectName(QStringLiteral("KithMootAttachDisplay"));
    display->setText(QStringLiteral(
        "KithMoot: attach drawings to the shared display and toggle drawing"));
    KGlobalAccel::self()->setDefaultShortcut(
        display, {QKeySequence(QStringLiteral("Meta+Shift+S"))});
    KGlobalAccel::self()->setShortcut(
        display, {QKeySequence(QStringLiteral("Meta+Shift+S"))});
    connect(display, &QAction::triggered, this,
            [this] { toggle(QStringLiteral("screen")); });
    auto stop = new QAction(this);
    stop->setObjectName(QStringLiteral("KithMootStopSharing"));
    stop->setText(QStringLiteral("KithMoot: stop sharing"));
    KGlobalAccel::self()->setDefaultShortcut(
        stop, {QKeySequence(QStringLiteral("Meta+Shift+X"))});
    KGlobalAccel::self()->setShortcut(
        stop, {QKeySequence(QStringLiteral("Meta+Shift+X"))});
    connect(stop, &QAction::triggered, this,
            [this] { post("/action", {{"action", "stop"}}); });
    auto clear = new QAction(this);
    clear->setObjectName(QStringLiteral("KithMootClearDrawing"));
    clear->setText(QStringLiteral("KithMoot: clear call drawings"));
    KGlobalAccel::self()->setDefaultShortcut(
        clear, {QKeySequence(QStringLiteral("Meta+Shift+C"))});
    KGlobalAccel::self()->setShortcut(
        clear, {QKeySequence(QStringLiteral("Meta+Shift+C"))});
    connect(clear, &QAction::triggered, this,
            [this] { post("/action", {{"action", "clear"}}); });
    connect(&timer, &QTimer::timeout, this, [this] {
      poll();
      if (drawing && bounds().isEmpty()) {
        points = {};
        endDrawing();
      }
      if (!strokes.isEmpty())
        effects->addRepaintFull();
    });
    timer.start(50);
    connect(effects, &EffectsHandler::screenLockingChanged, this,
            [this](bool locked) {
              if (locked)
                reset();
            });
  }
  ~KithMootMarks() override { reset(); }
  bool isActive() const override {
    return !session.isEmpty() && !effects->isScreenLocked() &&
           (drawing || !strokes.isEmpty());
  }
  int requestedEffectChainPosition() const override { return 90; }
  void grabbedKeyboardEvent(QKeyEvent *event) override {
    if (event->type() == QEvent::KeyPress && event->key() == Qt::Key_Escape)
      endDrawing();
  }
#if KM_KWIN_67
  void pointerMotion(PointerMotionEvent *event) override {
    input(QEvent::MouseMove, event->position, Qt::NoButton);
  }
  void pointerButton(PointerButtonEvent *event) override {
    input(event->state == PointerButtonState::Pressed
              ? QEvent::MouseButtonPress
              : QEvent::MouseButtonRelease,
          event->position, event->button);
  }
#else
  void windowInputMouseEvent(QEvent *event) override {
    if (auto mouse = dynamic_cast<QMouseEvent *>(event))
      input(event->type(), mouse->position(), mouse->button());
  }
#endif
  void input(QEvent::Type type, const QPointF &pos, Qt::MouseButton button) {
    if (!drawing)
      return;
    const QRectF rect = bounds();
    if (rect.isEmpty()) {
      points = {};
      endDrawing();
      return;
    }
    QJsonObject point{
        {"x", qBound(0.0, (pos.x() - rect.x()) / rect.width(), 1.0)},
        {"y", qBound(0.0, (pos.y() - rect.y()) / rect.height(), 1.0)}};
    if (type == QEvent::MouseButtonPress && button == Qt::LeftButton &&
        rect.contains(pos)) {
      points = QJsonArray{point};
      sent.restart();
    } else if (type == QEvent::MouseMove && !points.isEmpty()) {
      points.append(point);
      if (sent.elapsed() >= 50 || points.size() >= 128)
        flush(true);
    } else if (type == QEvent::MouseButtonRelease)
      flush(false);
  }
#if KM_KWIN_68
  bool paintScreen(const RenderTarget &target, const RenderViewport &viewport,
                   int mask, const DrawingRegion &region,
                   DrawingOutput *output) override {
    if (!effects->paintScreen(target, viewport, mask, region, output))
      return false;
    paintMarks(target, viewport);
    return true;
  }
#else
  void paintScreen(const RenderTarget &target, const RenderViewport &viewport,
                   int mask, const DrawingRegion &region,
                   DrawingOutput *output) override {
    effects->paintScreen(target, viewport, mask, region, output);
    paintMarks(target, viewport);
  }
#endif
  void paintMarks(const RenderTarget &target, const RenderViewport &viewport) {
    const QRectF rect = bounds();
    if (rect.isEmpty())
      return;
    if (const auto context = effects->openglContext()) {
      glEnable(GL_BLEND);
      glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
      glLineWidth(qMax(3.0, rect.width() / 260) * viewport.scale());
      ShaderBinder shader(ShaderTrait::UniformColor |
                          ShaderTrait::TransformColorspace);
      shader.shader()->setUniform(
          GLShader::Mat4Uniform::ModelViewProjectionMatrix,
          viewport.projectionMatrix());
      shader.shader()->setColorspaceUniforms(ColorDescription::sRGB,
                                             target.colorDescription(),
                                             RenderingIntent::Perceptual);
      auto buffer = GLVertexBuffer::streamingBuffer();
      buffer->reset();
      for (const auto &value : strokes) {
        const auto stroke = value.toObject();
        QColor colour(stroke.value("color").toString());
        if (!colour.isValid())
          continue;
        colour.setAlphaF(qBound(0.0, stroke.value("alpha").toDouble(), 1.0));
        shader.shader()->setUniform(GLShader::ColorUniform::Color, colour);
        QList<QVector2D> vertices;
        const auto list = stroke.value("points").toArray();
        if (list.size() > 256)
          continue;
        for (const auto &entry : list) {
          const auto p = entry.toObject();
          vertices.append(
              QVector2D((rect.x() + p.value("x").toDouble() * rect.width()) *
                            viewport.scale(),
                        (rect.y() + p.value("y").toDouble() * rect.height()) *
                            viewport.scale()));
        }
        buffer->setVertices(vertices);
        buffer->render(GL_LINE_STRIP);
      }
      glLineWidth(1);
      glDisable(GL_BLEND);
    }
#if !KM_KWIN_68
    else if (auto painter = effects->scenePainter()) {
      painter->save();
      for (const auto &value : strokes) {
        const auto stroke = value.toObject();
        QColor colour(stroke.value("color").toString());
        colour.setAlphaF(qBound(0.0, stroke.value("alpha").toDouble(), 1.0));
        QPen pen(colour, qMax(3.0, rect.width() / 260), Qt::SolidLine,
                 Qt::RoundCap, Qt::RoundJoin);
        painter->setPen(pen);
        QPolygonF line;
        for (const auto &entry : stroke.value("points").toArray()) {
          const auto p = entry.toObject();
          line << QPointF(rect.x() + p.value("x").toDouble() * rect.width(),
                          rect.y() + p.value("y").toDouble() * rect.height());
        }
        painter->drawPolyline(line);
      }
      painter->restore();
    }
#endif
  }

private:
  QRectF bounds() const {
    if (kind == "screen")
      return monitor ? QRectF(monitor->geometry()) : QRectF{};
    if (!window || window->isDeleted() || window->isMinimized() ||
        !window->isOnCurrentDesktop() || !window->isOnCurrentActivity())
      return {};
    if (!drawing && effects->activeWindow() != window)
      return {};
    return window->frameGeometry();
  }
  void toggle(const QString &selectedKind) {
    if (session.isEmpty())
      return;
    if (kind != selectedKind) {
      points = {};
      endDrawing();
      window = nullptr;
      kind = selectedKind;
      post("/target", {{"kind", kind}});
    }
    if (!window) {
      window = effects->activeWindow();
      if (!window)
        return;
      auto output = effects->screenAt(effects->cursorPos().toPoint());
      if (!output) {
        window = nullptr;
        return;
      }
      monitor = output;
    }
    if (drawing) {
      endDrawing();
      return;
    }
    if (!effects->grabKeyboard(this))
      return;
    drawing = true;
    effects->startMouseInterception(this, Qt::CrossCursor);
    effects->addRepaintFull();
  }
  void endDrawing() {
    flush(false);
    if (drawing) {
      drawing = false;
      effects->stopMouseInterception(this);
      effects->ungrabKeyboard();
      effects->addRepaintFull();
    }
  }
  void reset() {
    points = {};
    endDrawing();
    window = nullptr;
    monitor = nullptr;
    session.clear();
    strokes = {};
    effects->addRepaintFull();
  }
  void flush(bool continued) {
    if (points.size() > 1)
      post("/stroke", {{"points", points}});
    const auto last = points.isEmpty() ? QJsonValue() : points.last();
    points = continued && !last.isUndefined() ? QJsonArray{last} : QJsonArray{};
    sent.restart();
  }
  void post(const char *path, QJsonObject value) {
    if (session.isEmpty())
      return;
    value.insert("session", session);
    QNetworkRequest request(QUrl(url + path));
    request.setRawHeader("Authorization", "Bearer " + token);
    request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    request.setTransferTimeout(1500);
    auto reply =
        http.post(request, QJsonDocument(value).toJson(QJsonDocument::Compact));
    connect(reply, &QNetworkReply::finished, reply, &QObject::deleteLater);
  }
  void poll() {
    if (pending)
      return;
    const QString base = qEnvironmentVariable(
        "XDG_STATE_HOME", QDir::homePath() + "/.local/state");
    QFile file(base + "/kithmoot/annotations.json");
    if (!file.open(QIODevice::ReadOnly) || file.size() > 2048) {
      reset();
      return;
    }
    const auto connection = QJsonDocument::fromJson(file.readAll()).object();
    const QUrl endpoint(connection.value("url").toString());
    const auto secret = connection.value("token").toString().toLatin1();
    if (endpoint.scheme() != "http" || endpoint.host() != "127.0.0.1" ||
        secret.size() != 64) {
      reset();
      return;
    }
    url = endpoint.toString();
    token = secret;
    QNetworkRequest request(QUrl(url + "/state"));
    request.setRawHeader("Authorization", "Bearer " + token);
    request.setTransferTimeout(1500);
    pending = true;
    auto reply = http.get(request);
    connect(reply, &QNetworkReply::finished, this, [this, reply] {
      pending = false;
      const auto bytes = reply->readAll();
      const auto value = QJsonDocument::fromJson(bytes).object();
      if (reply->error() != QNetworkReply::NoError || bytes.size() > 262144 ||
          !value.value("session").isString() ||
          !value.value("strokes").isArray()) {
        reset();
        reply->deleteLater();
        return;
      }
      const auto next = value.value("session").toString();
      if (next != session)
        reset();
      session = next;
      kind = value.value("kind").toString();
      strokes = value.value("strokes").toArray();
      effects->addRepaintFull();
      reply->deleteLater();
    });
  }
  QNetworkAccessManager http;
  QTimer timer;
  QElapsedTimer sent;
  QPointer<EffectWindow> window;
  QPointer<DrawingOutput> monitor;
  QString session, kind, url;
  QByteArray token;
  QJsonArray strokes, points;
  bool pending = false, drawing = false;
};
KWIN_EFFECT_FACTORY(KithMootMarks, "metadata.json")
} // namespace KWin
#include "marks.moc"
