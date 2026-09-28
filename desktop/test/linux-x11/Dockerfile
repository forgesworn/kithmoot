# A disposable X11 desktop for driving the packaged Linux app with real mouse
# input: Xorg on a dummy driver with two monitors, and Cinnamon's window manager.
FROM node:22-bookworm
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    xserver-xorg-core xserver-xorg-video-dummy x11-utils x11-xserver-utils xdotool dbus-x11 \
    muffin cinnamon-settings-daemon cinnamon-desktop-data cinnamon-common gsettings-desktop-schemas dconf-gsettings-backend libgl1-mesa-dri \
    libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxtst6 libdrm2 libxkbcommon0 libatspi2.0-0 libcups2 \
    libxcomposite1 libxdamage1 libxrandr2 libxfixes3 libpango-1.0-0 libcairo2 fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /work
RUN npm init -y >/dev/null && npm install --no-audit --no-fund playwright-core@1.56.1
COPY xorg.conf session.sh /work/
RUN chmod +x /work/session.sh
