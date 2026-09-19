// search_memory 工具定义和实现

import type { MemorySystem } from './memory-system';
import type { SearchOptions, MemoryConfig } from './types';

/**
 * 动态生成 search_memory 工具定义
 * 根据配置调整描述和检索词要求
 */
export function createSearchMemoryToolDefinition(config: MemoryConfig) {
  const bm25Enabled = config.bm25.enabled;
  const vectorEnabled = config.vector.enabled;

  // 根据启用的检索方式生成描述
  let searchMethod = '';
  let queryGuidance = '';

  if (bm25Enabled && vectorEnabled) {
    searchMethod = '混合检索（关键词 + 语义相似度）';
    queryGuidance = `查询格式：直接使用自然语言描述需要查询的核心内容，系统自动匹配关键词检索和向量检索。`;
  } else if (bm25Enabled) {
    searchMethod = '关键词检索（BM25）';
    queryGuidance = `查询格式：提取 2-5 个核心关键词，空格分隔`;
  } else if (vectorEnabled) {
    searchMethod = '语义相似度检索';
    queryGuidance = `查询格式：用完整的自然语言描述要找的内容`;
  } else {
    searchMethod = '检索功能未启用';
    queryGuidance = '检索功能未启用，禁止调用当前工具';
  }

  return {
    name: 'search_memory',
    description: `当上下文信息缺失，该工具尝试从用户所有的会话记录中检索相关信息。

检索方式：${searchMethod}

${queryGuidance}

使用场景：
- 用户询问"之前说过的XX"、"还记得XX吗"等问题
- 用户提到之前讨论过的内容，需要回忆具体细节
- 需要了解用户在历史会话中的偏好、决策或背景信息
- 当前会话经过压缩，需要恢复早期的讨论内容

注意事项：
- 一次调用即可，无需多次尝试不同查询
- 工具会自动返回最相关的结果
- 搜索范围包括所有历史会话和当前会话`,

    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: bm25Enabled && vectorEnabled
            ? '自然语言查询，描述要找什么。系统会自动处理关键词提取和语义匹配。'
            : bm25Enabled
            ? '关键词查询，2-5 个核心词，空格分隔'
            : '自然语言查询，完整描述要找的内容'
        },
        limit: {
          type: 'number',
          description: '返回结果数量。默认 2（推荐），最多 10。',
          default: 2
        }
      },
      required: ['query']
    }
  };
}

/**
 * 检查是否应该启用 search_memory 工具
 */
export function shouldEnableSearchMemory(config: MemoryConfig): boolean {
  return config.bm25.enabled || config.vector.enabled;
}

/**
 * search_memory 工具实现
 */
export async function executeSearchMemory(
  memorySystem: MemorySystem,
  args: { query: string; limit?: number },
  currentSessionId?: string
): Promise<string> {
  const limit = Math.min(args.limit || 2, 10);

  const options: SearchOptions = {
    limit,
    // 不排除当前会话，因为可能需要找压缩前的内容
    excludeCurrentSession: false,
    currentSessionId
  };

  try {
    const results = await memorySystem.searchMemory(args.query, options);

    if (results.length === 0) {
      return '未找到相关的历史对话记忆。';
    }

    // 格式化结果
    let output = `找到 ${results.length} 条相关历史对话：\n\n`;

    results.forEach((result, index) => {
      const date = new Date(result.timestamp).toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });

      const sessionLabel = result.session_id === currentSessionId ? '(当前会话)' : '(历史会话)';
      const sourceLabel = result.source === 'hybrid' ? '混合匹配' : result.source === 'vector' ? '语义匹配' : '关键词匹配';

      output += `### 对话 ${index + 1} ${sessionLabel} - ${date}\n`;
      output += `**相关度**: ${(result.score * 100).toFixed(1)}% (${sourceLabel})\n\n`;
      output += `**用户**: ${result.user_input}\n\n`;
      output += `**助手**: ${result.assistant_output}\n\n`;
      output += `---\n\n`;
    });

    return output;
  } catch (error) {
    console.error('[search_memory] Search failed:', error);
    return `搜索历史对话时出错: ${error instanceof Error ? error.message : String(error)}`;
  }
}
