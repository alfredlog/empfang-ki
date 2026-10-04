#!/usr/bin/env bash
# Tägliches Datenbank-Backup für Empfang KI.
# Legt eine komprimierte Sicherung an und löscht Sicherungen, die älter als KEEP_DAYS sind.
#
# Einrichten (einmalig, als Benutzer alfred):
#   chmod +x ~/empfang-ki/infra/backup.sh
#   crontab -e      →  Zeile einfügen:
#   30 3 * * * /home/alfred/empfang-ki/infra/backup.sh >> /home/alfred/backups/backup.log 2>&1
#
# Wiederherstellen (überschreibt die aktuelle Datenbank!):
#   pg_restore --clean --if-exists -d "$DATABASE_URL" ~/backups/empfang/empfang-2026-10-04.dump
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/empfang}"
KEEP_DAYS="${KEEP_DAYS:-14}"

# DATABASE_URL aus der .env lesen
DATABASE_URL="$(grep -E '^DATABASE_URL=' "$APP_DIR/.env" | head -n1 | cut -d= -f2- | tr -d '"')"
if [ -z "$DATABASE_URL" ]; then
  echo "$(date -Is) FEHLER: DATABASE_URL nicht in $APP_DIR/.env gefunden" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
FILE="$BACKUP_DIR/empfang-$(date +%F).dump"

# -Fc = komprimiertes Format, mit pg_restore wiederherstellbar
pg_dump -Fc --no-owner "$DATABASE_URL" -f "$FILE.tmp"
mv "$FILE.tmp" "$FILE"
chmod 600 "$FILE"

# Alte Sicherungen löschen
find "$BACKUP_DIR" -name 'empfang-*.dump' -mtime +"$KEEP_DAYS" -delete

echo "$(date -Is) Backup ok: $FILE ($(du -h "$FILE" | cut -f1))"
