import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

export function useStateRef<T>(initialValue: T | (() => T)) {
  const [value, setValue] = useState(initialValue)
  const valueRef = useRef(value)

  const set = (nextValue: SetStateAction<T>) => {
    setValue((currentValue) => {
      const resolvedValue =
        typeof nextValue === 'function' ? (nextValue as (value: T) => T)(currentValue) : nextValue
      valueRef.current = resolvedValue
      return resolvedValue
    })
  }

  useEffect(() => {
    valueRef.current = value
  }, [value])

  return [value, set as Dispatch<SetStateAction<T>>, valueRef] as const
}
