import { BrandWordmark, FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import styles from './Brand.module.css'

const OFFICIAL_PRODUCT_NAME = 'DeepSeek Harness'

function productName(): string {
  const configured = process.env.DSH_CLIENT_TITLE
  return configured !== undefined && configured.length > 0 ? configured : OFFICIAL_PRODUCT_NAME
}

function productInitial(title: string): string {
  return Array.from(title.trim())[0]?.toUpperCase() ?? 'H'
}

/**
 * Render the official mark with the presentation requested by its host surface.
 * Company builds replace the whale mark with the company initial.
 * @param props - Host-supplied mark presentation.
 * @returns the official whale mark or the company initial.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  const title = productName()
  if (title === OFFICIAL_PRODUCT_NAME) return <FishLogo size={size} />
  return <span className={styles.mark} style={{ width: size, height: size, fontSize: size * 0.58 }} aria-hidden="true">
    {productInitial(title)}
  </span>
}

/**
 * Render the official name artwork without its independently slotted mark.
 * Company builds show the packaged product name instead.
 * @returns the official name wordmark or the company product name.
 */
export function OfficialBrandName() {
  const title = productName()
  return title === OFFICIAL_PRODUCT_NAME
    ? <BrandWordmark includeMark={false} />
    : <span className={styles.name}>{title}</span>
}
