package com.hermesandroid.bridge.client

/**
 * Attempt counter + exponential backoff for [RelayClient] reconnects.
 *
 * State lives here rather than in the reconnect coroutine on purpose: every
 * failed connect fires another `onFailure`, which schedules another reconnect.
 * A counter local to that coroutine restarts at zero each time, so an
 * unreachable address never exhausts its retries and loops forever.
 *
 * The budget is only restored by [reset] (a user-initiated connect) or by
 * [onSessionEnded] for a session that stayed up at least [stableSessionMs].
 * Merely reaching `onOpen` is NOT enough: a relay that accepts the socket and
 * immediately closes it (wrong pairing code, auth reject) would otherwise
 * refill the budget on every attempt and flap forever.
 *
 * All state is guarded by this object's monitor — [RelayClient] touches it from
 * OkHttp callback threads, the reconnect coroutine, and the main thread.
 */
class ReconnectPolicy(
    private val maxRetries: Int = 5,
    private val maxBackoffMs: Long = 30_000L,
    private val baseBackoffMs: Long = 1_000L,
    private val stableSessionMs: Long = 60_000L,
) {

    private var attemptCount: Int = 0

    val attempts: Int
        @Synchronized get() = attemptCount

    /** True once [maxRetries] attempts have been handed out without a reset. */
    val isExhausted: Boolean
        @Synchronized get() = attemptCount >= maxRetries

    val limit: Int
        get() = maxRetries

    /**
     * Consume one attempt and return how long to wait before it.
     * Caller must check [isExhausted] first.
     */
    @Synchronized
    fun nextBackoffMs(): Long {
        val exponent = attemptCount.coerceAtMost(30)
        attemptCount++
        val backoff = baseBackoffMs shl exponent
        return if (backoff <= 0L) maxBackoffMs else backoff.coerceAtMost(maxBackoffMs)
    }

    /**
     * Report that a connection that had opened is now gone, having lasted
     * [durationMs]. Only a session that proved stable refills the budget.
     */
    @Synchronized
    fun onSessionEnded(durationMs: Long) {
        if (durationMs >= stableSessionMs) attemptCount = 0
    }

    @Synchronized
    fun reset() {
        attemptCount = 0
    }
}
