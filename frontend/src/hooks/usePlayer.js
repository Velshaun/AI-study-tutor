import { useContext } from 'react'

import { PlayerContext } from '../context/player-context'

export function usePlayer() {
  const context = useContext(PlayerContext)
  if (!context) {
    throw new Error('usePlayer must be used inside <PlayerProvider>')
  }
  return context
}
