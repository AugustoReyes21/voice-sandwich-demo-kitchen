<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import {
    connectKitchen,
    disconnectKitchen,
    kitchenConnected,
    kitchenOrders,
    updateKitchenOrderStatus,
  } from "../kitchen";
  import type { KitchenOrder, OrderStatus } from "../types";

  const statusLabels: Record<OrderStatus, string> = {
    new: "nuevo",
    preparing: "en preparacion",
    ready: "listo",
  };

  const nextStatus: Record<OrderStatus, OrderStatus> = {
    new: "preparing",
    preparing: "ready",
    ready: "new",
  };

  const statusClasses: Record<OrderStatus, string> = {
    new: "bg-amber-100 text-amber-900 border-amber-200",
    preparing: "bg-sky-100 text-sky-900 border-sky-200",
    ready: "bg-emerald-100 text-emerald-900 border-emerald-200",
  };

  function formatTime(value: string) {
    return new Intl.DateTimeFormat("es-GT", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(value));
  }

  function ordersByStatus(orders: KitchenOrder[], status: OrderStatus) {
    return orders.filter((order) => order.status === status);
  }

  onMount(connectKitchen);
  onDestroy(disconnectKitchen);
</script>

<svelte:head>
  <title>Cocina | Voice Sandwich Demo</title>
</svelte:head>

<main class="min-h-screen bg-zinc-950 text-zinc-50">
  <section class="mx-auto flex max-w-7xl flex-col gap-6 px-5 py-6">
    <header class="flex flex-col gap-4 border-b border-zinc-800 pb-5 md:flex-row md:items-end md:justify-between">
      <div>
        <p class="text-sm font-medium uppercase tracking-wide text-zinc-400">Kitchen Display System</p>
        <h1 class="mt-1 text-3xl font-semibold tracking-normal text-white">Pedidos en cocina</h1>
      </div>

      <div class="flex items-center gap-3 text-sm">
        <span
          class={`h-3 w-3 rounded-full ${$kitchenConnected ? "bg-emerald-400" : "bg-red-400"}`}
          aria-hidden="true"
        ></span>
        <span class="text-zinc-300">{$kitchenConnected ? "Conectado en tiempo real" : "Reconectando..."}</span>
      </div>
    </header>

    <div class="grid gap-4 lg:grid-cols-3">
      {#each ["new", "preparing", "ready"] as status}
        <section class="min-h-[70vh] rounded border border-zinc-800 bg-zinc-900/80">
          <div class="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
            <h2 class="text-lg font-semibold capitalize text-white">{statusLabels[status as OrderStatus]}</h2>
            <span class="rounded-full bg-zinc-800 px-3 py-1 text-sm text-zinc-300">
              {ordersByStatus($kitchenOrders, status as OrderStatus).length}
            </span>
          </div>

          <div class="flex flex-col gap-3 p-3">
            {#each ordersByStatus($kitchenOrders, status as OrderStatus) as order (order.id)}
              <article class="rounded border border-zinc-700 bg-zinc-950 p-4 shadow-lg shadow-black/20">
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <h3 class="text-xl font-bold text-white">{order.id}</h3>
                    <p class="mt-1 text-sm text-zinc-400">Hora: {formatTime(order.createdAt)}</p>
                  </div>
                  <span class={`rounded border px-2 py-1 text-xs font-semibold ${statusClasses[order.status]}`}>
                    {statusLabels[order.status]}
                  </span>
                </div>

                <ul class="mt-4 space-y-2 text-base text-zinc-100">
                  {#each order.items as item}
                    <li class="rounded bg-zinc-900 px-3 py-2">{item}</li>
                  {/each}
                </ul>

                <p class="mt-4 text-sm leading-6 text-zinc-400">{order.summary}</p>

                <button
                  class="mt-4 w-full rounded bg-white px-4 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!$kitchenConnected}
                  on:click={() => updateKitchenOrderStatus(order.id, nextStatus[order.status])}
                >
                  Cambiar a {statusLabels[nextStatus[order.status]]}
                </button>
              </article>
            {:else}
              <p class="rounded border border-dashed border-zinc-700 px-4 py-8 text-center text-sm text-zinc-500">
                No hay pedidos en este estado.
              </p>
            {/each}
          </div>
        </section>
      {/each}
    </div>
  </section>
</main>
