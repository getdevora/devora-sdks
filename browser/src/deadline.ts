/** Bound even integrations/transports that ignore AbortSignal. Late rejections are observed. */
export async function withDeadline<T>(
	task: () => T | PromiseLike<T>,
	timeoutMs: number,
	onTimeout?: () => void
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			Promise.resolve().then(task),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					try {
						onTimeout?.()
					} finally {
						reject(new Error("Operation timed out"))
					}
				}, timeoutMs)
			}),
		])
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}
