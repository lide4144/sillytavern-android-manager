#!/system/bin/sh
# Run in Android's root shell; SOURCE must refer to the SAME PHONE's private config.
# Usage: su -c 'sh /data/local/tmp/provision-android.sh /proc/CONTAINER_PID/root/opt/st-subscription-proxy/manager/manager-access.json'
set -eu
[ "$(id -u)" = 0 ] || { echo 'Android root shell required'; exit 1; }
SOURCE=${1:-}
PKG=com.yg.subscriptionmanager
DEST=/data/user/0/$PKG
[ -f "$SOURCE" ] || { echo 'Pass an existing private manager-access.json path accessible to Android root'; exit 1; }
[ -d "$DEST" ] || { echo 'Install and launch the manager app once'; exit 1; }
OWNER=$(stat -c %u "$DEST")
mkdir -p "$DEST/files"
cp "$SOURCE" "$DEST/files/manager-config.json"
chown "$OWNER:$OWNER" "$DEST/files" "$DEST/files/manager-config.json"
chmod 700 "$DEST/files"
chmod 600 "$DEST/files/manager-config.json"
restorecon -RF "$DEST/files"
echo 'Private config provisioned without printing its secret. Reopen the manager app.'
