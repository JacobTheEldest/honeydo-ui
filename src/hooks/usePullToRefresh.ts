import { useCallback, useRef, useState, type SyntheticEvent } from 'react'
import { useDrag } from '@use-gesture/react'
import { startedOnDragHandle } from '../utils/gestureOrigin.ts'

export function usePullToRefresh(fetchTasks: () => Promise<unknown>) {
  const mainRef = useRef<HTMLElement>(null)
  const [pullDistance, setPullDistance] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const pullOriginOnHandleRef = useRef<boolean | null>(null)
  const pullGestureAllowedRef = useRef(false)
  const pullThreshold = 72

  const rememberPullOrigin = useCallback((event: SyntheticEvent<HTMLElement>) => {
    pullOriginOnHandleRef.current = startedOnDragHandle(event.nativeEvent)
  }, [])

  const bindPull = useDrag(
    (state) => {
      const { offset, last, first, event } = state
      const [, dy] = offset

      if (first) {
        if (pullOriginOnHandleRef.current === null) {
          pullOriginOnHandleRef.current = startedOnDragHandle(event)
        }
        pullGestureAllowedRef.current =
          pullOriginOnHandleRef.current !== true && (mainRef.current?.scrollTop ?? 0) === 0
      }

      // A drag handle belongs exclusively to dnd-kit for this full pointer
      // sequence; don't let this ancestor recognizer translate or refresh.
      if (!pullGestureAllowedRef.current) {
        if (last) {
          pullOriginOnHandleRef.current = null
          pullGestureAllowedRef.current = false
        }
        return
      }

      if (last) {
        if (dy >= pullThreshold && !isRefreshing) {
          setIsRefreshing(true)
          fetchTasks().catch(() => {}).finally(() => setIsRefreshing(false))
        }
        setPullDistance(0)
        pullOriginOnHandleRef.current = null
        pullGestureAllowedRef.current = false
      } else {
        setPullDistance(Math.max(0, dy / 3))
      }
    },
    {
      axis: 'y',
      from: () => [0, pullDistance],
      filterTaps: true,
      preventScroll: true,
      pointer: { touch: true },
    }
  )

  return { mainRef, pullDistance, isRefreshing, bindPull, rememberPullOrigin }
}
