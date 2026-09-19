// 记忆系统主类

import * as path from 'path';
import { MemoryDatabase } from './database';
import { VectorManager } from './vector-manager';
import type { MemoryConfig, SearchResult, SearchOptions } from './types';

export class MemorySystem {
  private db: MemoryDatabase;
  private vectorManager: VectorManager | null = null;
  private config: MemoryConfig;
  private dataDir: string;
  private currentModelGetter?: () => { endpoint: string; model: string; apiKey?: string };

  constructor(dataDir: string, config: MemoryConfig) {
    this.dataDir = dataDir;
    this.config = config;
    this.db = new MemoryDatabase(dataDir);
  }

  /** 设置当前模型获取器（用于 summaryModelSource = 'current' 时） */
  setCurrentModelGetter(getter: () => { endpoint: string; model: string; apiKey?: string }): void {
    this.currentModelGetter = getter;
  }

  /** 初始化 */
  async initialize(): Promise<void> {
    // 初始化向量管理器
    if (this.config.vector.enabled) {
      const modelName = this.config.vector.embeddingModel;
      const dimension = this.config.vector.embeddingDimension || 1024;

      if (!modelName) {
        console.warn('[Memory] 向量模型未配置，跳过向量管理器初始化');
      } else {
        // 根据模型名称和维度创建专属的向量管理器
        this.vectorManager = new VectorManager(this.dataDir, modelName, dimension);
        await this.vectorManager.initialize();
        console.log(`[Memory] 向量管理器已初始化: ${modelName} (${dimension}维)`);
      }
    }

    // 同步配置到数据库
    this.db.updateVectorConfig(
      this.config.vector.enabled,
      this.config.vector.embeddingEndpoint,
      this.config.vector.embeddingModel
    );
  }

  /** 添加对话记录 */
  async addConversation(
    sessionId: string,
    turnId: string,
    userInput: string,
    assistantOutput: string
  ): Promise<void> {
    // 1. 同步存储到 SQLite（无论 BM25 是否启用，都存储，防止幽灵消息）
    const conversationId = this.db.addConversation(sessionId, turnId, userInput, assistantOutput);

    // 2. 异步向量索引（仅在启用且健康时）
    if (this.config.vector.enabled && await this.isVectorHealthy()) {
      this.processVectorIndexing(conversationId, sessionId, turnId, userInput, assistantOutput)
        .catch(err => {
          console.error('[Memory] Vector indexing failed:', err.message);
          // 静默失败，不影响用户
        });
    }
  }

  /** 异步处理向量索引 */
  private async processVectorIndexing(
    conversationId: number,
    sessionId: string,
    turnId: string,
    userInput: string,
    assistantOutput: string
  ): Promise<void> {
    if (!this.vectorManager) {
      throw new Error('Vector manager not initialized');
    }

    try {
      // Step 1: 生成总结
      const summary = await this.summarizeConversation(userInput, assistantOutput);

      // 检查记录是否还存在（可能已被删除）
      try {
        this.db.updateSummary(conversationId, summary);
      } catch (error) {
        // 记录已被删除，放弃索引
        console.log('[Memory] Conversation deleted during indexing, skipping');
        return;
      }

      // Step 2: 生成向量
      const embedding = await this.generateEmbedding(summary);

      // Step 3: 存储向量
      const vectorIndex = await this.vectorManager.addVector(
        conversationId,
        sessionId,
        turnId,
        embedding
      );

      // Step 4: 记录元数据（可能失败，如果记录已被删除）
      try {
        this.db.saveVectorMeta(conversationId, vectorIndex);
        // 记录成功
        this.db.recordVectorSuccess();
      } catch (error) {
        // 外键约束失败，说明记录已被删除
        // 删除刚才添加的向量
        await this.vectorManager.deleteVectors([conversationId]);
        console.log('[Memory] Conversation deleted during indexing, rolled back');
      }
    } catch (error) {
      // 任何环节失败都记录并中断
      console.error('[Memory] Vector indexing failed:', error);
      this.db.recordVectorFailure();
      throw error; // 抛出以便外层捕获
    }
  }

  /** 生成对话总结 */
  private async summarizeConversation(
    userInput: string,
    assistantOutput: string
  ): Promise<string> {
    const prompt = `请用一句话总结下面这段对话的核心内容：

<user>
${userInput}
</user>
<assistant>
${assistantOutput}
</assistant>

要求：
1、总结内容不超过100字。
2、总结内容包括用户问题总结和助手回答总结。
3、直接输出总结内容，不要输出其他无关文字。

总结：`;

    // 根据配置选择模型
    let endpoint: string;
    let model: string;
    let apiKey: string | undefined;

    if (this.config.vector.summaryModelSource === 'custom') {
      endpoint = this.config.vector.summaryEndpoint!;
      model = this.config.vector.summaryModel!;
      apiKey = this.config.vector.summaryApiKey;
    } else {
      // 使用当前对话模型
      if (!this.currentModelGetter) {
        throw new Error('Current model getter not set');
      }
      const currentModel = this.currentModelGetter();
      endpoint = currentModel.endpoint;
      model = currentModel.model;
      apiKey = currentModel.apiKey; // 从当前模型获取 API Key
    }

    return await this.callLLM(endpoint, model, prompt, apiKey);
  }

  /** 调用 LLM */
  private async callLLM(
    endpoint: string,
    model: string,
    prompt: string,
    apiKey?: string
  ): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.vector.timeout);

    try {
      // 构建请求体 - 使用标准参数
      const requestBody: any = {
        model: model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        stream: false
      };

      const response = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey && { 'Authorization': `Bearer ${apiKey}` })
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(`LLM API error: ${response.status} ${errorText}`);
      }

      const data = await response.json();

      // 提取纯文本内容，去除可能的思考标记
      let content = data.choices[0].message.content.trim();

      // 清理可能残留的思考标记
      content = content.replace(/<think>[\s\S]*?<\/think>/g, '');
      content = content.replace(/【思考】[\s\S]*?【\/思考】/g, '');
      content = content.trim();

      // 检查内容是否为空
      if (!content) {
        throw new Error('LLM 返回了空内容');
      }

      return content;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** 生成向量 */
  private async generateEmbedding(text: string): Promise<number[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.vector.timeout);

    try {
      const response = await fetch(`${this.config.vector.embeddingEndpoint}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.vector.embeddingApiKey && { 'Authorization': `Bearer ${this.config.vector.embeddingApiKey}` })
        },
        body: JSON.stringify({
          model: this.config.vector.embeddingModel,
          input: text
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data.data[0].embedding;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** 语义改写：优化用户查询，提取核心语义 */
  private async rewriteQuery(query: string): Promise<string> {
    const prompt = `请将下面的查询改写为简洁清晰的语义描述，用于检索历史对话：

<查询>
${query}
</查询>

要求：
1. 提取核心语义，去除冗余信息。
2. 保持查询完整的核心诉求。
3. 不超过50字。
4. 只输出改写后的语义描述，不要其他内容。

改写：`;

    // 根据配置选择模型
    let endpoint: string;
    let model: string;
    let apiKey: string | undefined;

    if (this.config.vector.summaryModelSource === 'custom') {
      endpoint = this.config.vector.summaryEndpoint!;
      model = this.config.vector.summaryModel!;
      apiKey = this.config.vector.summaryApiKey;
    } else {
      // 使用当前对话模型
      if (!this.currentModelGetter) {
        throw new Error('Current model getter not set');
      }
      const currentModel = this.currentModelGetter();
      endpoint = currentModel.endpoint;
      model = currentModel.model;
      apiKey = currentModel.apiKey;
    }

    return await this.callLLM(endpoint, model, prompt, apiKey);
  }

  /** 从自然语言查询中提取关键词 */
  private async extractKeywords(query: string): Promise<string> {
    const prompt = `为下面的查询提供关键词检索需要的关键词：

<查询>
${query}
</查询>

要求如下：
1、从查询中提取 2-5 个核心关键词。
2、关键词之间用空格分隔。
3、只输出关键词，不要输出其他内容。

关键词：`;

    // 根据配置选择模型
    let endpoint: string;
    let model: string;
    let apiKey: string | undefined;

    if (this.config.vector.summaryModelSource === 'custom') {
      endpoint = this.config.vector.summaryEndpoint!;
      model = this.config.vector.summaryModel!;
      apiKey = this.config.vector.summaryApiKey;
    } else {
      // 使用当前对话模型
      if (!this.currentModelGetter) {
        throw new Error('Current model getter not set');
      }
      const currentModel = this.currentModelGetter();
      endpoint = currentModel.endpoint;
      model = currentModel.model;
      apiKey = currentModel.apiKey;
    }

    return await this.callLLM(endpoint, model, prompt, apiKey);
  }

  /** 搜索记忆 */
  async searchMemory(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const limit = options.limit ?? 5;
    const results = new Map<number, SearchResult>();

    const bm25Enabled = this.config.bm25.enabled;
    const vectorEnabled = this.config.vector.enabled && await this.isVectorHealthy();

    // 混合模式：并行执行关键词提取和语义改写
    if (bm25Enabled && vectorEnabled) {
      // 启动关键词提取（用于 BM25）
      const keywordsPromise = this.extractKeywords(query).catch(err => {
        console.error('[Memory] 关键词提取失败，使用原始查询:', err.message);
        return query;
      });

      // 启动语义改写（用于向量检索）
      const rewritePromise = this.rewriteQuery(query).catch(err => {
        console.error('[Memory] 语义改写失败，使用原始查询:', err.message);
        return query;
      });

      // 等待两个并行任务完成
      const [bm25Query, vectorQuery] = await Promise.all([keywordsPromise, rewritePromise]);

      // 启动向量检索
      const vectorPromise = this.searchVector(vectorQuery, limit * 2).catch(err => {
        console.warn('[Memory] 向量检索失败:', err.message);
        this.db.recordVectorFailure();
        return [];
      });

      // BM25 检索
      const bm25Promise = (async () => {
        try {
          return this.db.searchBM25(bm25Query, limit * 2);
        } catch (error) {
          console.error('[Memory] BM25检索失败:', error);
          return [];
        }
      })();

      // 等待两种检索完成
      const [bm25Results, vectorResults] = await Promise.all([bm25Promise, vectorPromise]);

      // 合并 BM25 结果
      bm25Results.forEach((r: any) => {
        results.set(r.conversation_id, {
          conversation_id: r.conversation_id,
          session_id: r.session_id,
          turn_id: r.turn_id,
          user_input: r.user_input,
          assistant_output: r.assistant_output,
          timestamp: r.timestamp,
          score: Math.abs(r.bm25_score),
          source: 'bm25'
        });
      });

      // 合并向量结果
      vectorResults.forEach(r => {
        const existing = results.get(r.conversation_id);
        if (existing) {
          existing.score = existing.score * 0.5 + r.score * 0.5;
          existing.source = 'hybrid';
        } else {
          results.set(r.conversation_id, r);
        }
      });

      if (vectorResults.length > 0) {
        this.db.recordVectorSuccess();
      }
    } else {
      // 单模式：直接检索
      if (bm25Enabled) {
        try {
          const bm25Results = this.db.searchBM25(query, limit * 2);
          bm25Results.forEach((r: any) => {
            results.set(r.conversation_id, {
              conversation_id: r.conversation_id,
              session_id: r.session_id,
              turn_id: r.turn_id,
              user_input: r.user_input,
              assistant_output: r.assistant_output,
              timestamp: r.timestamp,
              score: Math.abs(r.bm25_score),
              source: 'bm25'
            });
          });
        } catch (error) {
          console.error('[Memory] BM25检索失败:', error);
        }
      }

      if (vectorEnabled) {
        try {
          // 纯向量模式：使用语义改写优化查询
          const rewrittenQuery = await this.rewriteQuery(query).catch(err => {
            console.error('[Memory] 语义改写失败，使用原始查询:', err.message);
            return query;
          });

          const vectorResults = await this.searchVector(rewrittenQuery, limit * 2);
          vectorResults.forEach(r => {
            results.set(r.conversation_id, r);
          });
          this.db.recordVectorSuccess();
        } catch (error) {
          console.warn('[Memory] 向量检索失败:', error instanceof Error ? error.message : String(error));
          this.db.recordVectorFailure();
        }
      }
    }

    // 排序 + 截断 + 过滤
    let finalResults = Array.from(results.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // 可选：排除当前会话
    if (options.excludeCurrentSession && options.currentSessionId) {
      finalResults = finalResults.filter(r => r.session_id !== options.currentSessionId);
    }

    return finalResults;
  }

  /** 向量检索 */
  private async searchVector(query: string, limit: number): Promise<SearchResult[]> {
    if (!this.vectorManager) {
      throw new Error('Vector manager not initialized');
    }

    // 1. 生成查询向量
    const queryEmbedding = await this.generateEmbedding(query);

    // 2. 向量检索
    const vectorResults = await this.vectorManager.searchVectors(queryEmbedding, limit);

    // 3. 获取完整对话内容
    const results: SearchResult[] = [];
    for (const vr of vectorResults) {
      if (!vr.metadata) continue;

      const conv = this.db.getConversation(vr.metadata.conversation_id);
      if (!conv) continue;

      results.push({
        conversation_id: conv.id,
        session_id: conv.session_id,
        turn_id: conv.turn_id,
        user_input: conv.user_input,
        assistant_output: conv.assistant_output,
        timestamp: conv.timestamp,
        score: 1 - vr.distance, // 距离转相似度
        source: 'vector'
      });
    }

    return results;
  }

  /** 删除会话 */
  /** 删除会话的所有记忆数据（无论配置如何，都删除所有数据） */
  async deleteSession(sessionId: string): Promise<void> {
    // 1. 获取所有 conversation_id（必须先获取，因为后面会删除记录）
    const conversationIds = this.db.getConversationIdsBySession(sessionId);

    // 2. 删除 SQLite 数据（BM25 + 元数据）
    //    无论 BM25 是否启用，都删除数据库记录，防止幽灵消息
    this.db.deleteSession(sessionId);

    // 3. 删除向量索引（无论向量检索是否启用，都删除向量文件）
    if (this.vectorManager && conversationIds.length > 0) {
      try {
        await this.vectorManager.deleteVectors(conversationIds);
        console.log(`[Memory] Deleted ${conversationIds.length} vectors for session ${sessionId}`);
      } catch (error) {
        console.error('[Memory] Vector deletion failed:', error);
        // 继续，不阻塞，但至少记录错误
      }
    }
  }

  /** 检查向量服务是否健康 */
  private async isVectorHealthy(): Promise<boolean> {
    const status = this.db.getVectorStatus();
    if (!status || !status.is_enabled) {
      return false;
    }

    // 连续失败超过阈值，暂时禁用
    if (status.consecutive_failures >= this.config.vector.failureThreshold) {
      console.warn('[Memory] Vector service degraded, using BM25 only');
      return false;
    }

    return true;
  }

  /** 更新配置 */
  async updateConfig(config: MemoryConfig): Promise<void> {
    const oldConfig = this.config;
    this.config = config;

    // 同步到数据库
    this.db.updateVectorConfig(
      config.vector.enabled,
      config.vector.embeddingEndpoint,
      config.vector.embeddingModel
    );

    // 检查向量模型是否变化
    const modelChanged =
      oldConfig.vector.embeddingModel !== config.vector.embeddingModel ||
      oldConfig.vector.embeddingDimension !== config.vector.embeddingDimension;

    // 如果向量模型变化或从禁用切换到启用，重新初始化向量管理器
    if (config.vector.enabled) {
      if (!this.vectorManager || modelChanged) {
        const modelName = config.vector.embeddingModel;
        const dimension = config.vector.embeddingDimension || 1024;

        if (modelName) {
          this.vectorManager = new VectorManager(this.dataDir, modelName, dimension);
          await this.vectorManager.initialize();
          console.log(`[Memory] 向量管理器已切换: ${modelName} (${dimension}维)`);
        }
      }
    }
  }

  /** 获取统计信息 */
  getStats() {
    return {
      database: this.db.getStats(),
      vector: this.vectorManager ? this.vectorManager.getStats() : null,
      status: this.db.getVectorStatus()
    };
  }

  /** 关闭 */
  close(): void {
    this.db.close();
  }
}
