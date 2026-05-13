import { writable } from "svelte/store";
import type { KitchenOrder, KitchenServerEvent, OrderStatus } from "./types";

export const kitchenOrders = writable<KitchenOrder[]>([]);
export const kitchenConnected = writable(false);

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function upsertOrder(order: KitchenOrder) {
  kitchenOrders.update((orders) => {
    if (order.status === "delivered") {
      return orders.filter((item) => item.id !== order.id);
    }

    const existingIndex = orders.findIndex((item) => item.id === order.id);
    if (existingIndex === -1) {
      return [...orders, order];
    }

    const next = [...orders];
    next[existingIndex] = order;
    return next;
  });
}

export function connectKitchen() {
  if (ws && ws.readyState <= WebSocket.OPEN) return;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${window.location.host}/kitchen-ws`);

  ws.onopen = () => {
    kitchenConnected.set(true);
  };

  ws.onmessage = (message) => {
    const event: KitchenServerEvent = JSON.parse(message.data);

    if (event.type === "orders_snapshot") {
      kitchenOrders.set(event.orders);
      return;
    }

    upsertOrder(event.order);
  };

  ws.onclose = () => {
    kitchenConnected.set(false);
    ws = null;
    reconnectTimer = setTimeout(connectKitchen, 1000);
  };

  ws.onerror = () => {
    kitchenConnected.set(false);
  };
}

export function disconnectKitchen() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  ws?.close();
  ws = null;
  kitchenConnected.set(false);
}

export function updateKitchenOrderStatus(orderId: string, status: OrderStatus) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(
    JSON.stringify({
      type: "update_order_status",
      orderId,
      status,
    })
  );
}
