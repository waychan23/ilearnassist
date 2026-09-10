<script setup lang="ts">
import { useAppStore } from "../../stores/app";

const emit = defineEmits<{ close: [] }>();
const store = useAppStore();
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">
        <h3>设置</h3>
        <button class="icon-btn" @click="emit('close')">✕</button>
      </div>
      <div class="modal-body">
        <div class="config-tip">
          模型与工具的 Provider 通过根目录 <code>config.yaml</code> 与 <code>.env</code> 配置，
          修改后需重启后端服务。API Key 不会暴露给前端。
        </div>

        <div class="field">
          <label>默认 Provider / 模型</label>
          <div class="value">{{ store.config?.defaultProvider }} / {{ store.config?.defaultModel }}</div>
        </div>

        <div class="field">
          <label>工作区根目录</label>
          <div class="value mono">{{ store.config?.workspacesRootDir }}</div>
        </div>

        <div class="field">
          <label>网页搜索 Provider</label>
          <div class="value">{{ store.config?.webSearchProvider }}</div>
        </div>

        <div class="field">
          <label>Providers</label>
          <table class="providers">
            <thead>
              <tr>
                <th>名称</th>
                <th>Base URL</th>
                <th>API Key</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in store.config?.providers ?? []" :key="p.id">
                <td>{{ p.name }}</td>
                <td class="mono">{{ p.baseURL }}</td>
                <td :class="p.hasApiKey ? 'ok' : 'missing'">
                  {{ p.hasApiKey ? "✓ 已配置" : "✗ 未配置" }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn primary" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.value {
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 10px;
}
.mono {
  font-family: "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 12px;
}
.providers {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.providers th,
.providers td {
  border: 1px solid var(--border);
  padding: 6px 10px;
  text-align: left;
}
.providers th {
  color: var(--text-3);
  font-weight: 500;
}
.ok {
  color: #4cc38a;
}
.missing {
  color: #e5534b;
}
</style>