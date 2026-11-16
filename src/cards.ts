import cardsJson from './content/cards.json'

export type Card = { id: string; name: string; subject: string; message: string }

export const cards: Card[] = cardsJson

/** Returns the card for a QR token, or undefined when the token is unknown. */
export function findCard(id: string | undefined): Card | undefined {
  return cards.find((c) => c.id === id)
}
