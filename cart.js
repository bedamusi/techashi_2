/**
 * Techashi Solutions Cart State Engine
 * Storage Key: 'techashi-cart-v1' (Aligned with reference techashi project)
 */

(function (window) {
  const STORAGE_KEY = 'techashi-cart-v1';

  function readStoredCart() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(parsed)
        ? parsed.filter(item => typeof item?.productId === 'string' && Number.isInteger(item.quantity) && item.quantity > 0)
        : [];
    } catch (e) {
      return [];
    }
  }

  function writeStoredCart(items) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch (e) {}
    updateCartBadges();
    window.dispatchEvent(new CustomEvent('techashi-cart-updated', { detail: { items } }));
  }

  const Cart = {
    getItems() {
      return readStoredCart();
    },

    getCount() {
      return readStoredCart().reduce((sum, item) => sum + item.quantity, 0);
    },

    addItem(product, quantity = 1) {
      if (!product || !product.id) return false;
      const items = readStoredCart();
      const existing = items.find(item => item.productId === product.id);
      const currentQty = existing ? existing.quantity : 0;
      const maxStock = product.stock != null ? product.stock : 99;
      const nextQty = Math.min(maxStock, currentQty + quantity, 99);

      let nextItems;
      if (existing) {
        nextItems = items.map(item => item.productId === product.id ? { ...item, quantity: nextQty } : item);
      } else {
        nextItems = [...items, { productId: product.id, quantity: nextQty }];
      }

      writeStoredCart(nextItems);

      // Trigger notification if showToast exists
      if (typeof window.showToast === 'function') {
        window.showToast({
          title: 'Added to Bag',
          message: `<strong class="text-slate-900">${product.name}</strong> was added to your bag. <a href="/cart" class="text-brand-blue font-bold underline ml-1">View Bag (${this.getCount()}) &rarr;</a>`,
          type: 'success',
          duration: 4500
        });
      }

      return true;
    },

    setQuantity(productId, quantity) {
      if (!Number.isInteger(quantity) || quantity < 1) {
        this.removeItem(productId);
        return;
      }
      const items = readStoredCart();
      const nextItems = items.map(item => item.productId === productId ? { ...item, quantity: Math.min(quantity, 99) } : item);
      writeStoredCart(nextItems);
    },

    removeItem(productId) {
      const items = readStoredCart().filter(item => item.productId !== productId);
      writeStoredCart(items);
    },

    clearCart() {
      writeStoredCart([]);
    }
  };

  function updateCartBadges() {
    const count = Cart.getCount();
    const badges = document.querySelectorAll('.cart-count-badge');
    badges.forEach(badge => {
      badge.textContent = count > 99 ? '99+' : count;
      if (count > 0) {
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    });
  }

  // Update badges on load and storage sync across tabs
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) updateCartBadges();
  });

  document.addEventListener('DOMContentLoaded', updateCartBadges);

  window.TechashiCart = Cart;
  window.updateCartBadges = updateCartBadges;
})(window);
