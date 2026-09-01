/**
 * Ejecuta `run` sobre `items` con como máximo `limit` promesas pendientes a la
 * vez, preservando el orden de entrada en los resultados. Alcanza con un puñado
 * de workers tirando de un cursor compartido; sumar una dependencia para esto
 * costaría más que las quince líneas que reemplaza.
 *
 * Esto existe por GitHub: sus rate limits secundarios se disparan por
 * CONCURRENCIA, no solo por volumen, así que un Promise.all sin límite sobre N
 * objetivos empieza a ser frenado justo cuando el llamador abre más el abanico.
 * Los llamadores acotan el fan-out acá en vez de redescubrirlo cada uno por su
 * cuenta.
 */
export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]);
    }
  });

  await Promise.all(workers);
  return results;
}
