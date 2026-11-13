import { SVGProps } from "react"
import type { Environment } from "../../../src/shared/config-types"
import PaciorIcon from "./PaciorIcon"

const ClineLogoSanta = (props: SVGProps<SVGSVGElement> & { environment?: Environment }) => {
	const { environment, ...svgProps } = props
	return <PaciorIcon variant="badge" {...svgProps} />
}
export default ClineLogoSanta
