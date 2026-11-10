"""Configuration only: importing the application never creates its data directory."""
import os
from pathlib import Path

ROOT=Path(__file__).resolve().parent
DATA=Path(os.environ.get('DATA_DIR',str(ROOT/'data')))
DB=DATA/'board.sqlite3'
ADMIN_USERNAME=os.environ.get('ADMIN_USERNAME','admin').strip().lower()
PUBLIC_ORIGIN=os.environ.get('PUBLIC_ORIGIN','').rstrip('/')
SECURE=os.environ.get('COOKIE_SECURE','0')=='1'
