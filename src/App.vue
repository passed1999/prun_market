<script setup lang="ts">
const nav = [
  { to: "/market", label: "全服市场" },
  { to: "/arbitrage", label: "套利" },
  { to: "/profit", label: "面积利润" },
  { to: "/routes", label: "路线编辑" },
];
</script>

<template>
  <div class="layout">
    <nav class="sidebar">
      <h1>PrUn Market</h1>
      <RouterLink v-for="item in nav" :key="item.to" :to="item.to">{{ item.label }}</RouterLink>
      <div class="credits">
        数据：<a href="https://doc.fnar.net/" target="_blank" rel="noopener">FIO</a> ·
        <a href="https://prunplanner.org/" target="_blank" rel="noopener">PRUNplanner</a> ·
        <a href="https://prun.raylu.net/stats/" target="_blank" rel="noopener">PrUn Financial Reports</a>
      </div>
    </nav>
    <main class="content">
      <RouterView />
    </main>
  </div>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; background: #16181d; color: #e2e2e2; }
.layout { display: flex; min-height: 100vh; }
.sidebar { width: 200px; padding: 16px; background: #1e2128; display: flex; flex-direction: column; gap: 8px; }
.sidebar h1 { font-size: 16px; margin: 0 0 16px; }
.sidebar a { color: #9db4d0; text-decoration: none; padding: 6px 8px; border-radius: 4px; }
.sidebar a.router-link-active { background: #2c3140; color: #fff; }
.sidebar .credits { margin-top: auto; font-size: 11px; color: #8a8f99; line-height: 1.6; }
.sidebar .credits a { padding: 0; }
.content { flex: 1; padding: 24px; min-width: 0; }
h2 { font-size: 18px; margin: 0 0 16px; }
table { border-collapse: collapse; }
th, td { border: 1px solid #333; padding: 4px 10px; }
@media (max-width: 800px) {
  .layout { flex-direction: column; }
  .sidebar { width: auto; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
  .sidebar h1 { margin: 0 12px 0 0; }
  .sidebar .credits { width: 100%; margin-top: 4px; }
  .content { padding: 16px; }
}
</style>
