import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/market" },
    { path: "/market", name: "market", component: () => import("../views/MarketView.vue") },
    { path: "/arbitrage", name: "arbitrage", component: () => import("../views/ArbitrageView.vue") },
    { path: "/profit", name: "profit", component: () => import("../views/ProfitView.vue") },
    { path: "/:pathMatch(.*)*", redirect: "/market" },
  ],
});
