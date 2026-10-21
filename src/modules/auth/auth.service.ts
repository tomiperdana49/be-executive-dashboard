import { verify } from 'hono/jwt'
import { config } from '../../config/config'
import { UnauthorizedException } from '../../core/exceptions/base'
import { GoogleLoginValidator, LoginValidator, RefreshTokenValidator } from './validators/auth.validator'
import { IUserService } from '../user/user.service.interface'
import { IIs5Service } from '../is5/is5.service.interface'
import { IAuthService } from './auth.service.interface'
import { AuthHelper } from '../../core/helpers/auth'

export class AuthService implements IAuthService {
    constructor(
        private readonly userService: IUserService,
        private readonly is5Service: IIs5Service
    ) {}

    async is5Login(data: LoginValidator) {
        const user = await this.userService.getByEmId(data.employeeId)
        if (!user.is_active) throw new UnauthorizedException('User is not active')

        const isDevLogin = config.devLogin.employeeIds.includes(data.employeeId)
        if (isDevLogin) {
            console.warn(`[DevLogin] IS5 password check skipped for ${data.employeeId}`)
        } else {
            const authenticated = await this.is5Service.auth(data.employeeId, data.password)
            if (!authenticated) throw new UnauthorizedException('Invalid credentials')
        }

        const { accessToken, refreshToken } = await AuthHelper.generateTokens(user)
        const { password, resetPasswordToken, resetPasswordExpires, ...userWithoutSensitiveData } = user
        return { user: userWithoutSensitiveData, accessToken, refreshToken }
    }

    async googleLogin(data: GoogleLoginValidator) {
        const payload = await AuthHelper.verifyGoogleCode(data.code)
        const user = await this.userService.getByEmail(payload.email!)
        if (!user.is_active) throw new UnauthorizedException('User is not active')

        const { accessToken, refreshToken } = await AuthHelper.generateTokens(user)
        const { password, resetPasswordToken, resetPasswordExpires, ...userWithoutSensitiveData } = user
        return { user: userWithoutSensitiveData, accessToken, refreshToken }
    }

    async refreshToken(data: RefreshTokenValidator) {
        try {
            const decoded = await verify(data.refreshToken, config.app.jwtRefreshSecret, 'HS256') as { sub: string }
            const user = await this.userService.getById(Number(decoded.sub))

            const { accessToken, refreshToken } = await AuthHelper.generateTokens(user)
            const { password, resetPasswordToken, resetPasswordExpires, ...userWithoutSensitiveData } = user
            return { user: userWithoutSensitiveData, accessToken, refreshToken }
        } catch {
            throw new UnauthorizedException('Invalid or expired refresh token')
        }
    }
}
