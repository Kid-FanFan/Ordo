// 记忆系统配置持久化

import * as fs from 'fs';
import * as path from 'path';
import type { MemoryConfig } from './types';

export class MemoryConfigStore {
  private configPath: string;

  constructor(dataDir: string) {
    this.configPath = path.join(dataDir, 'memory-config.json');
  }

  /** 加载配置 */
  load(): MemoryConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf-8');
        const config = JSON.parse(data);
        // 兼容旧配置：添加默认维度
        if (config.vector && !config.vector.embeddingDimension) {
          config.vector.embeddingDimension = 1024;
        }
        return config;
      }
    } catch (error) {
      console.error('[MemoryConfig] Failed to load config:', error);
    }

    // 返回默认配置
    return {
      bm25: { enabled: true },
      vector: {
        enabled: false,
        embeddingEndpoint: '',
        embeddingModel: '',
        embeddingDimension: 1024,
        summaryModelSource: 'current',
        timeout: 30000,
        maxRetries: 2,
        failureThreshold: 3
      }
    };
  }

  /** 保存配置 */
  save(config: MemoryConfig): void {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
    } catch (error) {
      console.error('[MemoryConfig] Failed to save config:', error);
      throw error;
    }
  }

  /** 验证配置 */
  static validate(config: MemoryConfig): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (config.vector.enabled) {
      if (!config.vector.embeddingEndpoint || !config.vector.embeddingEndpoint.trim()) {
        errors.push('向量模型 API 地址不能为空');
      }

      if (!config.vector.embeddingModel || !config.vector.embeddingModel.trim()) {
        errors.push('向量模型名称不能为空');
      }

      if (config.vector.summaryModelSource === 'custom') {
        if (!config.vector.summaryEndpoint || !config.vector.summaryEndpoint.trim()) {
          errors.push('自定义总结模型 API 地址不能为空');
        }

        if (!config.vector.summaryModel || !config.vector.summaryModel.trim()) {
          errors.push('自定义总结模型名称不能为空');
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }
}
