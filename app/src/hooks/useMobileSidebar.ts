import { create } from 'zustand';

interface MobileSidebarStore {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const useMobileSidebar = create<MobileSidebarStore>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
