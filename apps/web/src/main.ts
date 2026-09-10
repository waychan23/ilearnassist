import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "highlight.js/styles/github-dark.css";
import "./style.css";

createApp(App).use(createPinia()).mount("#app");