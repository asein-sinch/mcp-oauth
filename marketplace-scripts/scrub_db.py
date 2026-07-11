#!/usr/bin/env python3
"""
Sinch Marketplace Database Scrubbing Tool
This script securely deletes all transaction event records inside the persistent SQLite 
database table 'events'. Use this to wipe mock events and start with a clean slate for production.
"""

import os
import sqlite3
import argparse

DEFAULT_DB_PATH = "marketplace.db"

def scrub_database(db_path):
    # Check if DB file exists
    if not os.path.exists(db_path):
        # 1. Look in sibling directory (if running from marketplace-scripts)
        sibling_path = os.path.join("..", "marketplace-dashboard", db_path)
        # 2. Look in subdirectory (if running from workspace root)
        sub_path = os.path.join("marketplace-dashboard", db_path)
        
        if os.path.exists(sibling_path):
            db_path = sibling_path
        elif os.path.exists(sub_path):
            db_path = sub_path
        else:
            print(f"❌ Error: Database file not found. (Checked: '{db_path}', '{sibling_path}', and '{sub_path}')")
            return

    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        # Check if table exists
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
        if not cursor.fetchone():
            print(f"⚠️ Table 'events' does not exist in database '{db_path}'. Nothing to scrub.")
            conn.close()
            return

        # Fetch count before deletion
        cursor.execute("SELECT COUNT(*) FROM events")
        count_before = cursor.fetchone()[0]
        
        # Execute delete query
        cursor.execute("DELETE FROM events")
        conn.commit()
        
        print(f"🧹 SECURE CLEAN COMPLETE: Successfully wiped {count_before} event records from '{db_path}'.")
        conn.close()
        
    except Exception as e:
        print(f"❌ Database scrub failed: {e}")

def main():
    parser = argparse.ArgumentParser(description="Securely wipe Marketplace events database table")
    parser.add_argument("--db", default=DEFAULT_DB_PATH, help="Path to SQLite database file")
    args = parser.parse_args()
    
    confirm = input(f"⚠️ WARNING: Are you sure you want to delete ALL event records from '{args.db}'? (y/N): ")
    if confirm.lower() == 'y':
        scrub_database(args.db)
    else:
        print("❌ Action cancelled.")

if __name__ == "__main__":
    main()
