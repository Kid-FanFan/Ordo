// 向量管理器（使用 vectra 纯 JS 实现）

import { LocalIndex } from 'vectra';
import * as path from 'path';
import * as crypto from 'crypto';

export class VectorManager {
  private index: LocalIndex | null = null;
  private indexPath: string;
  private initialized: boolean = false;

  constructor(dataDir: string, modelName: string, dimension: number = 1024) {
    // 根据模型名称生成唯一的索引目录
    // 使用 hash 避免特殊字符问题，同时保留可读性
    const modelHash = crypto.createHash('md5').update(modelName).digest('hex').slice(0, 8);
    const safeName = modelName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
    const indexDirName = `vectors_${safeName}_${modelHash}_d${dimension}`;

    this.indexPath = path.join(dataDir, indexDirName);
    console.log(`[VectorManager] 索引目录: ${indexDirName}`);
  }

  /** 初始化（应用启动时调用） */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      this.index = new LocalIndex(this.indexPath);

      // 尝试加载现有索引
      if (await this.index.isIndexCreated()) {
        await this.index.beginUpdate();
        await this.index.endUpdate();
      } else {
        // 创建新索引
        await this.index.createIndex();
      }

      this.initialized = true;
    } catch (error) {
      console.error('[VectorManager] Failed to initialize:', error);
      // 创建新索引
      this.index = new LocalIndex(this.indexPath);
      await this.index.createIndex();
      this.initialized = true;
    }
  }

  /** 添加向量 */
  async addVector(
    conversationId: number,
    sessionId: string,
    turnId: string,
    embedding: number[]
  ): Promise<number> {
    if (!this.index || !this.initialized) {
      throw new Error('VectorManager not initialized');
    }

    await this.index.beginUpdate();

    try {
      // 使用 conversation_id 作为唯一标识
      const itemId = `conv_${conversationId}`;

      // 检查是否已存在，如果存在则先删除
      try {
        await this.index.deleteItem(itemId);
      } catch (err) {
        // 不存在，忽略错误
      }

      await this.index.insertItem({
        id: itemId,
        vector: embedding,
        metadata: {
          conversation_id: conversationId,
          session_id: sessionId,
          turn_id: turnId,
          timestamp: Date.now()
        }
      });

      await this.index.endUpdate();

      return conversationId;
    } catch (error) {
      await this.index.cancelUpdate();
      throw error;
    }
  }

  /** 搜索相似向量 */
  async searchVectors(
    queryEmbedding: number[],
    k: number = 10
  ): Promise<Array<{ vectorIndex: number; distance: number; metadata: any }>> {
    if (!this.index || !this.initialized) {
      throw new Error('VectorManager not initialized');
    }

    // vectra 的 queryItems 签名: queryItems(vector, query, topK, filter?, isBm25?)
    // 我们只做向量搜索，query 参数传空字符串
    const results = await this.index.queryItems(queryEmbedding, '', k);

    return results.map((r: any) => ({
      vectorIndex: r.item.metadata.conversation_id,
      distance: 1 - r.score, // vectra 返回的是相似度分数，转换为距离
      metadata: r.item.metadata
    }));
  }

  /** 删除向量 */
  async deleteVectors(conversationIds: number[]): Promise<void> {
    if (!this.index || !this.initialized) {
      return;
    }

    await this.index.beginUpdate();

    try {
      for (const id of conversationIds) {
        const itemId = `conv_${id}`;
        try {
          await this.index.deleteItem(itemId);
        } catch (err) {
          // 忽略删除失败（可能不存在）
        }
      }

      await this.index.endUpdate();
    } catch (error) {
      await this.index.cancelUpdate();
      console.error('[VectorManager] 删除向量失败:', error);
      throw error;
    }
  }

  /** 获取统计信息 */
  getStats() {
    return {
      totalVectors: 0, // vectra 没有提供直接获取数量的方法
      indexSize: 0,
      initialized: this.initialized
    };
  }
}
