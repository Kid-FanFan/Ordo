// SQLite 数据库管理

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import type { ConversationRecord, VectorServiceStatus } from './types';

export class MemoryDatabase {
  private db: Database.Database;

  constructor(dataDir: string) {
    const dbPath = path.join(dataDir, 'memory.db');

    // 确保目录存在
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL'); // 提高并发性能
    this.initialize();
  }

  private initialize(): void {
    // 创建表结构
    this.db.exec(`
      -- 对话记录主表
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        user_input TEXT NOT NULL,
        assistant_output TEXT NOT NULL,
        summary TEXT,
        timestamp INTEGER NOT NULL,
        metadata TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_session_id ON conversations(session_id);
      CREATE INDEX IF NOT EXISTS idx_timestamp ON conversations(timestamp);

      -- BM25 全文索引表（使用外部内容表模式，简单字符分词）
      CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(
        content,
        content='conversations',
        content_rowid='id',
        tokenize='trigram'
      );

      -- 触发器：自动同步到 FTS 索引
      DROP TRIGGER IF EXISTS conversations_ai;
      CREATE TRIGGER conversations_ai AFTER INSERT ON conversations BEGIN
        INSERT INTO conversations_fts(rowid, content)
        VALUES (new.id, new.user_input || ' ' || new.assistant_output);
      END;

      DROP TRIGGER IF EXISTS conversations_au;
      CREATE TRIGGER conversations_au AFTER UPDATE ON conversations BEGIN
        INSERT INTO conversations_fts(conversations_fts, rowid, content)
        VALUES('delete', old.id, old.user_input || ' ' || old.assistant_output);
        INSERT INTO conversations_fts(rowid, content)
        VALUES (new.id, new.user_input || ' ' || new.assistant_output);
      END;

      DROP TRIGGER IF EXISTS conversations_ad;
      CREATE TRIGGER conversations_ad AFTER DELETE ON conversations BEGIN
        INSERT INTO conversations_fts(conversations_fts, rowid, content)
        VALUES('delete', old.id, old.user_input || ' ' || old.assistant_output);
      END;

      -- 向量索引元数据表
      CREATE TABLE IF NOT EXISTS vector_index_meta (
        conversation_id INTEGER PRIMARY KEY,
        vector_index INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      -- 向量服务状态表
      CREATE TABLE IF NOT EXISTS vector_service_status (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        is_enabled BOOLEAN DEFAULT 0,
        endpoint_url TEXT,
        model_name TEXT,
        last_success_at INTEGER,
        last_failure_at INTEGER,
        consecutive_failures INTEGER DEFAULT 0,
        status TEXT DEFAULT 'unknown'
      );

      -- 初始化向量服务状态
      INSERT OR IGNORE INTO vector_service_status (id, is_enabled, consecutive_failures, status)
      VALUES (1, 0, 0, 'unknown');
    `);
  }

  /** 添加对话记录（同步，立即完成） */
  addConversation(
    sessionId: string,
    turnId: string,
    userInput: string,
    assistantOutput: string
  ): number {
    const stmt = this.db.prepare(`
      INSERT INTO conversations (session_id, turn_id, user_input, assistant_output, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);

    const result = stmt.run(sessionId, turnId, userInput, assistantOutput, Date.now());
    return result.lastInsertRowid as number;
  }

  /** 更新对话的总结 */
  updateSummary(conversationId: number, summary: string): void {
    const stmt = this.db.prepare(`
      UPDATE conversations SET summary = ? WHERE id = ?
    `);
    stmt.run(summary, conversationId);
  }

  /** 保存向量索引元数据 */
  saveVectorMeta(conversationId: number, vectorIndex: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO vector_index_meta (conversation_id, vector_index, indexed_at)
      VALUES (?, ?, ?)
    `);
    stmt.run(conversationId, vectorIndex, Date.now());
  }

  /** BM25 搜索 */
  searchBM25(query: string, limit: number): any[] {
    // 简单分词：按空格分割，过滤空词
    const words = query
      .split(/\s+/)
      .filter(word => word.length > 0);

    if (words.length === 0) {
      return [];
    }

    // 构建 FTS5 查询：每个词用 OR 连接
    const ftsQuery = words.join(' OR ');

    const stmt = this.db.prepare(`
      SELECT
        c.id as conversation_id,
        c.session_id,
        c.turn_id,
        c.user_input,
        c.assistant_output,
        c.timestamp,
        bm25(conversations_fts) as bm25_score
      FROM conversations_fts
      JOIN conversations c ON c.id = conversations_fts.rowid
      WHERE conversations_fts MATCH ?
      ORDER BY bm25_score
      LIMIT ?
    `);

    try {
      return stmt.all(ftsQuery, limit);
    } catch (error) {
      console.error('[BM25] 查询失败:', error);
      return [];
    }
  }

  /** 获取对话详情 */
  getConversation(conversationId: number): ConversationRecord | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM conversations WHERE id = ?
    `);
    return stmt.get(conversationId) as ConversationRecord | undefined;
  }

  /** 获取会话的所有 conversation_id（用于删除向量） */
  getConversationIdsBySession(sessionId: string): number[] {
    const stmt = this.db.prepare(`
      SELECT id FROM conversations WHERE session_id = ?
    `);
    const conversations = stmt.all(sessionId) as Array<{ id: number }>;
    return conversations.map(c => c.id);
  }

  /** 删除会话的所有对话 */
  deleteSession(sessionId: string): void {
    // 删除记录（触发器会自动清理 FTS）
    const deleteStmt = this.db.prepare(`
      DELETE FROM conversations WHERE session_id = ?
    `);
    deleteStmt.run(sessionId);
  }

  /** 获取向量服务状态 */
  getVectorStatus(): VectorServiceStatus | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM vector_service_status WHERE id = 1
    `);
    return stmt.get() as VectorServiceStatus | undefined;
  }

  /** 更新向量服务配置 */
  updateVectorConfig(enabled: boolean, endpointUrl?: string, modelName?: string): void {
    const stmt = this.db.prepare(`
      UPDATE vector_service_status
      SET is_enabled = ?, endpoint_url = ?, model_name = ?, consecutive_failures = 0, status = 'unknown'
      WHERE id = 1
    `);
    stmt.run(enabled ? 1 : 0, endpointUrl || null, modelName || null);
  }

  /** 记录向量服务成功 */
  recordVectorSuccess(): void {
    const stmt = this.db.prepare(`
      UPDATE vector_service_status
      SET consecutive_failures = 0, last_success_at = ?, status = 'healthy'
      WHERE id = 1
    `);
    stmt.run(Date.now());
  }

  /** 记录向量服务失败 */
  recordVectorFailure(): void {
    const stmt = this.db.prepare(`
      UPDATE vector_service_status
      SET
        consecutive_failures = consecutive_failures + 1,
        last_failure_at = ?,
        status = CASE
          WHEN consecutive_failures >= 2 THEN 'down'
          ELSE 'degraded'
        END
      WHERE id = 1
    `);
    stmt.run(Date.now());
  }

  /** 获取统计信息 */
  getStats() {
    const countStmt = this.db.prepare(`SELECT COUNT(*) as count FROM conversations`);
    const vectorCountStmt = this.db.prepare(`SELECT COUNT(*) as count FROM vector_index_meta`);

    return {
      totalConversations: (countStmt.get() as any).count,
      vectorIndexed: (vectorCountStmt.get() as any).count
    };
  }

  /** 关闭数据库 */
  close(): void {
    this.db.close();
  }
}
