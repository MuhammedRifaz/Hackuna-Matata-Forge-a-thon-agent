import { SVGProps } from "react"

interface PaciorIconProps extends SVGProps<SVGSVGElement> {
	/**
	 * Render with a dark navy squircle container for universal high-contrast legibility,
	 * or transparent adaptive. Defaults to "badge" for consistent premium branding.
	 */
	variant?: "badge" | "adaptive" | "original"
}

export const PaciorIcon = ({ variant = "badge", className = "size-12", ...props }: PaciorIconProps) => {
	if (variant === "original") {
		return (
			<svg
				className={className}
				fill="none"
				role="img"
				viewBox="0 0 360 360"
				xmlns="http://www.w3.org/2000/svg"
				{...props}>
				<title>Pacior</title>
				<g>
					{/* Accent lime square */}
					<path
						d="M181.261 195.681v37.586c0 .376-.302.681-.674.681h-38.469c-.372 0-.674-.305-.674-.681v-37.586c0-.376.302-.681.674-.681h38.469c.372 0 .674.305.674.681z"
						fill="#B9E01E"
					/>
					{/* Arch */}
					<path
						d="M267.519 153.404c0 26.596-13.716 50.16-35.109 64.906-11.622 8.26-25.674 13.725-41.081 15.481-.429.049-.822-.301-.822-.737v-38.308c2.013-.552 4.027-1.103 5.914-1.929 16.61-6.477 28.187-21.773 28.187-39.412 0-23.703-20.637-42.995-46.182-42.995-25.544 0-46.182 19.292-46.182 42.995v133.782c0 .395-.317.716-.708.716H93.189c-.391 0-.708-.32-.708-.716V153.404c0-1.103 0-2.343.252-3.445 1.762-43.409 40.142-77.86 87.204-77.86 48.447 0 87.582 36.38 87.582 81.305z"
						fill="#012E47"
					/>
				</g>
			</svg>
		)
	}

	if (variant === "badge") {
		return (
			<svg
				className={className}
				fill="none"
				role="img"
				viewBox="0 0 360 360"
				xmlns="http://www.w3.org/2000/svg"
				{...props}>
				<title>Pacior</title>
				<defs>
					<linearGradient id="pacior-badge-bg" x1="0%" y1="0%" x2="100%" y2="100%">
						<stop offset="0%" stopColor="#012E47" />
						<stop offset="100%" stopColor="#001B2B" />
					</linearGradient>
				</defs>
				{/* Squircle container in deep navy #012E47 */}
				<rect
					fill="url(#pacior-badge-bg)"
					height="340"
					rx="76"
					stroke="#B9E01E"
					strokeOpacity="0.35"
					strokeWidth="6"
					width="340"
					x="10"
					y="10"
				/>
				<g>
					{/* Accent lime square with high-contrast vibrancy */}
					<path
						d="M181.261 195.681v37.586c0 .376-.302.681-.674.681h-38.469c-.372 0-.674-.305-.674-.681v-37.586c0-.376.302-.681.674-.681h38.469c.372 0 .674.305.674.681z"
						fill="#B9E01E"
					/>
					{/* Arch in crisp white #FFFFFF against deep navy (13.8:1 contrast) */}
					<path
						d="M267.519 153.404c0 26.596-13.716 50.16-35.109 64.906-11.622 8.26-25.674 13.725-41.081 15.481-.429.049-.822-.301-.822-.737v-38.308c2.013-.552 4.027-1.103 5.914-1.929 16.61-6.477 28.187-21.773 28.187-39.412 0-23.703-20.637-42.995-46.182-42.995-25.544 0-46.182 19.292-46.182 42.995v133.782c0 .395-.317.716-.708.716H93.189c-.391 0-.708-.32-.708-.716V153.404c0-1.103 0-2.343.252-3.445 1.762-43.409 40.142-77.86 87.204-77.86 48.447 0 87.582 36.38 87.582 81.305z"
						fill="#FFFFFF"
					/>
				</g>
			</svg>
		)
	}

	// Adaptive variant: uses CSS variables for theme responsiveness
	return (
		<svg
			className={className}
			fill="none"
			role="img"
			viewBox="0 0 360 360"
			xmlns="http://www.w3.org/2000/svg"
			{...props}>
			<title>Pacior</title>
			<g>
				<path
					d="M181.261 195.681v37.586c0 .376-.302.681-.674.681h-38.469c-.372 0-.674-.305-.674-.681v-37.586c0-.376.302-.681.674-.681h38.469c.372 0 .674.305.674.681z"
					fill="#B9E01E"
				/>
				<path
					className="text-foreground fill-current"
					d="M267.519 153.404c0 26.596-13.716 50.16-35.109 64.906-11.622 8.26-25.674 13.725-41.081 15.481-.429.049-.822-.301-.822-.737v-38.308c2.013-.552 4.027-1.103 5.914-1.929 16.61-6.477 28.187-21.773 28.187-39.412 0-23.703-20.637-42.995-46.182-42.995-25.544 0-46.182 19.292-46.182 42.995v133.782c0 .395-.317.716-.708.716H93.189c-.391 0-.708-.32-.708-.716V153.404c0-1.103 0-2.343.252-3.445 1.762-43.409 40.142-77.86 87.204-77.86 48.447 0 87.582 36.38 87.582 81.305z"
				/>
			</g>
		</svg>
	)
}

export default PaciorIcon

