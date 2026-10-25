// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
namespace pn_pdf {
bool md5(const unsigned char* input, unsigned int length, unsigned char* output);
bool rc4(const unsigned char* key, unsigned int key_length, const unsigned char* input, unsigned int length, unsigned char* output);
bool aes_cbc_decrypt(const unsigned char* key, unsigned int key_length, const unsigned char* iv, const unsigned char* input, unsigned int length, unsigned char* output);
}
