import sqlite3

import pytest

from posting_core.db_migrations import apply_migrations, migration_status, verify_schema


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    yield connection
    connection.close()


def test_migrations_apply_once(conn):
    first = apply_migrations(conn)
    second = apply_migrations(conn)

    assert [row["migration_id"] for row in first] == [
        "20260623_0001",
        "20260624_0002",
        "20260625_0003",
        "20260625_0004",
    ]
    assert second == []
    status = migration_status(conn)
    assert status[0]["applied"] is True
    assert status[0]["checksum_ok"] is True
    assert verify_schema(conn) == []


def test_verify_reports_missing_schema(conn):
    assert "missing table: posts" in verify_schema(conn)
