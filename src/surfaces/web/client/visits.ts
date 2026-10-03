/** Whether the play book has been open during this page's lifetime. */
let bookOpened = false;

export function markBookOpened(): void {
  bookOpened = true;
}

export function wasBookOpened(): boolean {
  return bookOpened;
}
