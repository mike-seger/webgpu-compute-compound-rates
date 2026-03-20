export function localDate(isoDateString) {
	if (typeof isoDateString.getMonth === 'function')
		isoDateString = isoDate(isoDateString)
	return new Date(isoDateString.substring(0, 10) + 'T00:00:00.000Z')
}

export function diffDays(isoDate1, isoDate2) {
	const diff = localDate(isoDate2).setHours(12) - localDate(isoDate1).setHours(12)
	return Math.round(diff / 8.64e7)
}

export function isoDate(date) {
	return date.getFullYear() + '-'
		+ ('0' + (date.getMonth() + 1)).slice(-2) + '-'
		+ ('0' + date.getDate()).slice(-2)
}

export function plusDays(isoDateStr, days) {
	if (typeof isoDateStr.getMonth === 'function')
		isoDateStr = isoDate(isoDateStr)
	const date = localDate(isoDateStr)
	const resDate = new Date(date)
	resDate.setDate(date.getDate() + days)
	return isoDate(resDate)
}
