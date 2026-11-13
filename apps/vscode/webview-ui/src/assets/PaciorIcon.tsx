import { SVGProps } from "react"

interface PaciorIconProps extends SVGProps<SVGSVGElement> {
	/**
	 * Explicit arch fill color (defaults to white for dark backgrounds, or currentColor).
	 */
	archColor?: string
	/**
	 * Explicit accent square fill color (defaults to #B9E01E).
	 */
	accentColor?: string
	/**
	 * Maintained for backwards compatibility. All variants render pure icon paths without any box or border.
	 */
	variant?: "badge" | "adaptive" | "original"
}

export const PaciorIcon = ({
	archColor = "#FFFFFF",
	accentColor = "#B9E01E",
	className = "w-12 h-12",
	...props
}: PaciorIconProps) => {
	// Bounding box of the pure icon:
	// Arch: x: 92.48 to 267.52, y: 72.10 to 287.19
	// Square: x: 142.12 to 181.26, y: 195.00 to 233.27
	// Centered in 0 0 360 360
	return (
		<svg
			className={className}
			fill="none"
			role="img"
			viewBox="0 0 360 360"
			xmlns="http://www.w3.org/2000/svg"
			{...props}>
			<title>Pacior Code</title>
			<g>
				{/* Accent lime square */}
				<path
					d="M181.261 195.681v37.586c0 .376-.302.681-.674.681h-38.469c-.372 0-.674-.305-.674-.681v-37.586c0-.376.302-.681.674-.681h38.469c.372 0 .674.305.674.681z"
					fill={accentColor}
				/>
				{/* Arch in crisp white (no box, no border) */}
				<path
					d="M267.519 153.404c0 26.596-13.716 50.16-35.109 64.906-11.622 8.26-25.674 13.725-41.081 15.481-.429.049-.822-.301-.822-.737v-38.308c2.013-.552 4.027-1.103 5.914-1.929 16.61-6.477 28.187-21.773 28.187-39.412 0-23.703-20.637-42.995-46.182-42.995-25.544 0-46.182 19.292-46.182 42.995v133.782c0 .395-.317.716-.708.716H93.189c-.391 0-.708-.32-.708-.716V153.404c0-1.103 0-2.343.252-3.445 1.762-43.409 40.142-77.86 87.204-77.86 48.447 0 87.582 36.38 87.582 81.305z"
					fill={archColor}
				/>
			</g>
		</svg>
	)
}

export default PaciorIcon
