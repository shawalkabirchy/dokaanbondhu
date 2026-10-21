<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class UpdatePriceRequest extends FormRequest
{
    public function rules(): array
    {
        $rules = [
            'retail_price' => 'sometimes|integer|between:1,1000000',
            'garage_price' => ['sometimes', 'integer', 'min:1'],
        ];

        return $rules;
    }
}
