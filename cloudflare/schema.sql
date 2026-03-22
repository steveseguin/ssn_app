CREATE TABLE IF NOT EXISTS error_logs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    install_id       TEXT    NOT NULL,
    version          TEXT    NOT NULL,
    type             TEXT    NOT NULL,
    message          TEXT,
    stack            TEXT,
    context_json     TEXT,
    settings_json    TEXT,
    client_timestamp TEXT,
    created_at       TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_install_id ON error_logs(install_id);
CREATE INDEX IF NOT EXISTS idx_type       ON error_logs(type);
CREATE INDEX IF NOT EXISTS idx_version    ON error_logs(version);
CREATE INDEX IF NOT EXISTS idx_created_at ON error_logs(created_at);
