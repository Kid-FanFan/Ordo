// 记忆系统类型定义

/** 记忆配置 */
export interface MemoryConfig {
  // BM25 配置（始终启用）
  bm25: {
    enabled: true;
  };

  // 向量检索配置（可选）
  vector: {
    enabled: boolean;
    embeddingEndpoint: string;
    embeddingModel: string;
    embeddingDimension: number;              // 向量维度（重要！切换模型时必须匹配）
    embeddingApiKey?: string;                // 向量化模型的 API 密钥

    // 总结模型配置
    summaryModelSource: 'current' | 'custom';
    summaryEndpoint?: string;
    summaryModel?: string;
    summaryApiKey?: string;                  // 总结模型的 API 密钥

    timeout: number;
    maxRetries: number;
    failureThreshold: number;
  };
}

/** 对话记录 */
export interface ConversationRecord {
  id: number;
  session_id: string;
  turn_id: string;
  user_input: string;
  assistant_output: string;
  summary?: string;
  timestamp: number;
  metadata?: string;
}

/** 搜索结果 */
export interface SearchResult {
  conversation_id: number;
  session_id: string;
  turn_id: string;
  user_input: string;
  assistant_output: string;
  timestamp: number;
  score: number;
  source: 'bm25' | 'vector' | 'hybrid';
}

/** 向量索引元数据 */
export interface VectorIndexMeta {
  conversation_id: number;
  vector_index: number;
  indexed_at: number;
}

/** 向量映射 */
export interface VectorMapping {
  [vectorIndex: number]: {
    conversation_id: number;
    session_id: string;
    turn_id: string;
    timestamp: number;
  };
}

/** 向量服务状态 */
export interface VectorServiceStatus {
  id: 1;
  is_enabled: boolean;
  endpoint_url?: string;
  model_name?: string;
  last_success_at?: number;
  last_failure_at?: number;
  consecutive_failures: number;
  status: 'unknown' | 'healthy' | 'degraded' | 'down';
}

/** 搜索选项 */
export interface SearchOptions {
  limit?: number;
  excludeCurrentSession?: boolean;
  currentSessionId?: string;
}
